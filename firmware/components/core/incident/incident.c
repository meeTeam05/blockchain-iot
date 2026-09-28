/* Schema v2 incident implementation.  No secret or digest is ever logged. */
#ifdef INCIDENT_HOST_TEST
/* The host vector test includes this production translation unit directly.
 * Only the deterministic codec section is compiled; platform/NVS/MQTT code
 * stays out of the host executable. */
#include "incident.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef INCIDENT_HOST_QUEUE_TEST
#include <time.h>
#endif
#include <openssl/sha.h>
#ifdef INCIDENT_HOST_CRYPTO_TEST
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/ecp.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/entropy.h>
#include <mbedtls/md.h>
#endif
typedef void *QueueHandle_t;
typedef void *SemaphoreHandle_t;
#ifdef INCIDENT_HOST_PERSISTENCE_TEST
#include "incident_persistence_shim.h"
#define FIRMWARE_VERSION "0.1.1-gas-ews"
#endif
#ifdef INCIDENT_HOST_ACK_TEST
#include "cJSON.h"
#endif
#define CONFIG_SA_ENABLE_BLOCKCHAIN_INCIDENT 1
#ifndef CONFIG_SA_INCIDENT_QUEUE_CAPACITY
#define CONFIG_SA_INCIDENT_QUEUE_CAPACITY 4
#endif
#define CONFIG_SA_INCIDENT_VERIFYING_CONTRACT "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC"
#else
#include "incident.h"

#include "config.h"
#include "cJSON.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/ecp.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/entropy.h"
#include "mbedtls/md.h"
#include "mqtt.h"
#include "nvs.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#endif

#if CONFIG_SA_ENABLE_BLOCKCHAIN_INCIDENT

#ifndef INCIDENT_HOST_TEST
static const char *TAG = "incident";
#endif

#define INCIDENT_NS "incidentv2"
#define INCIDENT_KEY_SEQ "sequence"
#define INCIDENT_KEY_SIGNER "signer"
#define INCIDENT_QUEUE_CAPACITY CONFIG_SA_INCIDENT_QUEUE_CAPACITY
#define INCIDENT_PAYLOAD_MAX 2048
#define INCIDENT_MAGIC 0x32494341u /* ACI2 */
#define INCIDENT_TASK_STACK 6144
#define INCIDENT_TASK_PRIORITY 2
#define INCIDENT_WORK_QUEUE_CAPACITY 4

/* The Keccak-f[1600] permutation is intentionally local: Ethereum uses
 * Keccak-256, not the incompatible FIPS SHA3-256 padding supplied by mbedTLS. */
typedef struct { uint64_t a[25]; uint8_t buf[136]; size_t used; } keccak_t;
static const uint64_t k_rc[24] = {0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL};
static const uint8_t k_rot[25] = {0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14};
static uint64_t rol64(uint64_t x, uint8_t n) { return n ? (x << n) | (x >> (64 - n)) : x; }
static uint64_t load64le(const uint8_t *p) { uint64_t x=0; for (int i=7;i>=0;i--) x=(x<<8)|p[i]; return x; }
static void store64le(uint8_t *p,uint64_t x) { for (int i=0;i<8;i++) { p[i]=(uint8_t)x; x>>=8; } }
static void keccakf(uint64_t a[25]) { for (int r=0;r<24;r++) { uint64_t c[5],d[5],b[25]; for(int x=0;x<5;x++) c[x]=a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20]; for(int x=0;x<5;x++) d[x]=c[(x+4)%5]^rol64(c[(x+1)%5],1); for(int x=0;x<5;x++) for(int y=0;y<5;y++) a[x+5*y]^=d[x]; for(int x=0;x<5;x++) for(int y=0;y<5;y++) b[y+5*((2*x+3*y)%5)]=rol64(a[x+5*y],k_rot[x+5*y]); for(int x=0;x<5;x++) for(int y=0;y<5;y++) a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]); a[0]^=k_rc[r]; } }
static void keccak_init(keccak_t *k) { memset(k,0,sizeof(*k)); }
static void keccak_update(keccak_t *k,const void *data,size_t n) { const uint8_t *p=data; while(n) { size_t m=136-k->used; if(m>n)m=n; memcpy(k->buf+k->used,p,m); k->used+=m;p+=m;n-=m; if(k->used==136) { for(int i=0;i<17;i++)k->a[i]^=load64le(k->buf+8*i); keccakf(k->a);k->used=0; } } }
static void keccak_final(keccak_t *k,uint8_t out[32]) { k->buf[k->used++]=0x01; memset(k->buf+k->used,0,136-k->used); k->buf[135]|=0x80; for(int i=0;i<17;i++)k->a[i]^=load64le(k->buf+8*i);keccakf(k->a);for(int i=0;i<4;i++)store64le(out+8*i,k->a[i]); }
static void keccak256(const void *data,size_t n,uint8_t out[32]) { keccak_t k;keccak_init(&k);keccak_update(&k,data,n);keccak_final(&k,out); }

typedef struct {
    uint16_t schema_version; uint8_t device_id_hash[32], incident_id[32]; uint64_t sequence, observed_at;
    uint8_t time_source; incident_snapshot_t snapshot; uint8_t incident_kind, severity;
    uint8_t firmware_version_hash[32], model_sha256[32]; uint32_t calibration_revision; uint8_t calibration_hash[32];
} evidence_t;
typedef struct {
    uint32_t magic; uint16_t len; uint16_t reserved; uint32_t checksum; uint64_t sequence;
    uint8_t incident_id[32], evidence_hash[32], signature[65]; char payload[INCIDENT_PAYLOAD_MAX];
} queued_record_t;
typedef struct {
    uint8_t previous_level, new_level;
    incident_snapshot_t snapshot;
} work_t;

#if !defined(INCIDENT_HOST_TEST) || defined(INCIDENT_HOST_PERSISTENCE_TEST)
static char s_device_id[18], s_topic[64];
#if !defined(INCIDENT_HOST_TEST) || defined(INCIDENT_HOST_QUEUE_TEST)
static incident_time_source_t s_time_source;
static QueueHandle_t s_work;
#endif
static SemaphoreHandle_t s_lock;
static uint32_t s_retry_count, s_queue_full_count;
#endif

/* `config_get_device_id()` resolves this exact lowercase STA-MAC form.  Keep
 * the incident boundary strict so deviceIdHash can never be made from a
 * display name, an uppercase MAC, or an arbitrary MQTT client identifier. */
static bool valid_device_id(const char *id)
{
    if (id == NULL || strlen(id) != 17) return false;
    for (size_t i = 0; i < 17; ++i) {
        if ((i % 3) == 2) {
            if (id[i] != ':') return false;
        } else if (!((id[i] >= '0' && id[i] <= '9') ||
                     (id[i] >= 'a' && id[i] <= 'f'))) {
            return false;
        }
    }
    return true;
}

static const char k_evidence_type[] = "IncidentEvidence(uint16 schemaVersion,bytes32 deviceIdHash,bytes32 incidentId,uint64 sequence,uint64 observedAt,uint8 timeSource,uint8 sensorValidMask,uint8 detectionMethod,int32 temperatureCx100,uint16 humidityPctX100,uint32 coPpmX1000,uint32 no2PpmX1000,uint8 overallLevel,uint8 coLevel,uint8 no2Level,uint8 coAlarmSourceMask,uint8 no2AlarmSourceMask,uint8 derivedValidMask,uint32 coStel15PpmX1000,uint32 no2Stel15PpmX1000,uint32 coTwa8hPpmX1000,uint32 no2Twa8hPpmX1000,uint32 coProj10PpmX1000,uint32 no2Proj10PpmX1000,uint8 modelProbabilityValidMask,uint16 coModelProbabilityBps,uint16 no2ModelProbabilityBps,uint8 incidentKind,uint8 severity,bytes32 firmwareVersionHash,bytes32 modelSha256,uint32 calibrationRevision,bytes32 calibrationHash)";
static const char k_attestation_type[] = "IncidentAttestation(bytes32 deviceIdHash,bytes32 incidentId,uint64 sequence,uint64 observedAt,uint8 severity,bytes32 evidenceHash)";

static void abi_u(uint8_t out[32],uint64_t x) { memset(out,0,32);for(int i=31;i>=24;i--){out[i]=(uint8_t)x;x>>=8;} }
static void abi_i32(uint8_t out[32],int32_t x) { memset(out,x<0?0xff:0,32); out[28]=(uint8_t)((uint32_t)x>>24);out[29]=(uint8_t)((uint32_t)x>>16);out[30]=(uint8_t)((uint32_t)x>>8);out[31]=(uint8_t)x; }
static void abi_hash_field(keccak_t *k,const uint8_t h[32]) { keccak_update(k,h,32); }
static void abi_uint_field(keccak_t *k,uint64_t v) { uint8_t w[32];abi_u(w,v);keccak_update(k,w,32); }
static void hex32(const uint8_t in[32],char out[67]) { static const char x[]="0123456789abcdef";out[0]='0';out[1]='x';for(int i=0;i<32;i++){out[2+i*2]=x[in[i]>>4];out[3+i*2]=x[in[i]&15];}out[66]=0; }
static bool parse_hex32(const char *s,uint8_t out[32]) { if(!s||strlen(s)!=66||s[0]!='0'||s[1]!='x')return false;for(int i=0;i<32;i++){char a=s[2+i*2],b=s[3+i*2];int hi=(a>='0'&&a<='9')?a-'0':(a>='a'&&a<='f')?a-'a'+10:-1,lo=(b>='0'&&b<='9')?b-'0':(b>='a'&&b<='f')?b-'a'+10:-1;if(hi<0||lo<0)return false;out[i]=(uint8_t)((hi<<4)|lo);}return true; }

static uint32_t record_checksum(const queued_record_t *r)
{
    uint32_t h = 2166136261u;
#define CHECKSUM_BYTES(ptr, count) do { const uint8_t *p_ = (const uint8_t *)(ptr); for (size_t i_ = 0; i_ < (count); ++i_) { h ^= p_[i_]; h *= 16777619u; } } while (0)
    CHECKSUM_BYTES(&r->magic, sizeof(r->magic)); CHECKSUM_BYTES(&r->len, sizeof(r->len));
    CHECKSUM_BYTES(&r->sequence, sizeof(r->sequence)); CHECKSUM_BYTES(r->incident_id, sizeof(r->incident_id));
    CHECKSUM_BYTES(r->evidence_hash, sizeof(r->evidence_hash)); CHECKSUM_BYTES(r->signature, sizeof(r->signature));
    if (r->len < INCIDENT_PAYLOAD_MAX) CHECKSUM_BYTES(r->payload, (size_t)r->len + 1u);
#undef CHECKSUM_BYTES
    return h;
}

static void hash_evidence(const evidence_t *e,uint8_t out[32]) { uint8_t h[32],w[32];keccak_t k;keccak256(k_evidence_type,strlen(k_evidence_type),h);keccak_init(&k);abi_hash_field(&k,h);abi_uint_field(&k,e->schema_version);abi_hash_field(&k,e->device_id_hash);abi_hash_field(&k,e->incident_id);abi_uint_field(&k,e->sequence);abi_uint_field(&k,e->observed_at);abi_uint_field(&k,e->time_source);abi_uint_field(&k,e->snapshot.sensor_valid_mask);abi_uint_field(&k,2);abi_i32(w,e->snapshot.temperature_c_x100);keccak_update(&k,w,32);abi_uint_field(&k,e->snapshot.humidity_pct_x100);abi_uint_field(&k,e->snapshot.co_ppm_x1000);abi_uint_field(&k,e->snapshot.no2_ppm_x1000);abi_uint_field(&k,e->snapshot.overall_level);abi_uint_field(&k,e->snapshot.co_level);abi_uint_field(&k,e->snapshot.no2_level);abi_uint_field(&k,e->snapshot.co_alarm_source_mask);abi_uint_field(&k,e->snapshot.no2_alarm_source_mask);abi_uint_field(&k,e->snapshot.derived_valid_mask);abi_uint_field(&k,e->snapshot.co_stel15_ppm_x1000);abi_uint_field(&k,e->snapshot.no2_stel15_ppm_x1000);abi_uint_field(&k,e->snapshot.co_twa8h_ppm_x1000);abi_uint_field(&k,e->snapshot.no2_twa8h_ppm_x1000);abi_uint_field(&k,e->snapshot.co_proj10_ppm_x1000);abi_uint_field(&k,e->snapshot.no2_proj10_ppm_x1000);abi_uint_field(&k,e->snapshot.model_probability_valid_mask);abi_uint_field(&k,e->snapshot.co_model_probability_bps);abi_uint_field(&k,e->snapshot.no2_model_probability_bps);abi_uint_field(&k,e->incident_kind);abi_uint_field(&k,e->severity);abi_hash_field(&k,e->firmware_version_hash);abi_hash_field(&k,e->model_sha256);abi_uint_field(&k,e->calibration_revision);abi_hash_field(&k,e->calibration_hash);keccak_final(&k,out); }
static void hash_incident_id(const uint8_t device[32],uint64_t seq,uint8_t out[32]) { uint8_t s[8];for(int i=7;i>=0;i--){s[i]=(uint8_t)seq;seq>>=8;}keccak_t k;keccak_init(&k);keccak_update(&k,"AIR-INCIDENT-2",14);keccak_update(&k,device,32);keccak_update(&k,s,8);keccak_final(&k,out); }
static bool contract_word(uint8_t out[32]) { const char *s=CONFIG_SA_INCIDENT_VERIFYING_CONTRACT; size_t n=strlen(s); memset(out,0,32); if(n!=42||s[0]!='0'||s[1]!='x')return false; for(int i=0;i<20;i++){char a=s[2+i*2],b=s[3+i*2];int hi=(a>='0'&&a<='9')?a-'0':(a>='a'&&a<='f')?a-'a'+10:(a>='A'&&a<='F')?a-'A'+10:-1,lo=(b>='0'&&b<='9')?b-'0':(b>='a'&&b<='f')?b-'a'+10:(b>='A'&&b<='F')?b-'A'+10:-1;if(hi<0||lo<0)return false;out[12+i]=(uint8_t)((hi<<4)|lo);}return true; }
static bool hash_digest(const evidence_t *e,const uint8_t ev_hash[32],uint8_t out[32]) { uint8_t att[32],domain[32],type[32],name[32],version[32],chain[32],contract[32],sh[32],pre[66];if(!contract_word(contract))return false;keccak256(k_attestation_type,strlen(k_attestation_type),att);const char *domain_type="EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";keccak256(domain_type,strlen(domain_type),type);keccak256("AirSafetyLog",12,name);keccak256("1",1,version);abi_u(chain,11155111);keccak_t k;keccak_init(&k);abi_hash_field(&k,type);abi_hash_field(&k,name);abi_hash_field(&k,version);keccak_update(&k,chain,32);keccak_update(&k,contract,32);keccak_final(&k,domain);keccak_init(&k);abi_hash_field(&k,att);abi_hash_field(&k,e->device_id_hash);abi_hash_field(&k,e->incident_id);abi_uint_field(&k,e->sequence);abi_uint_field(&k,e->observed_at);abi_uint_field(&k,e->severity);abi_hash_field(&k,ev_hash);keccak_final(&k,sh);pre[0]=0x19;pre[1]=0x01;memcpy(pre+2,domain,32);memcpy(pre+34,sh,32);keccak256(pre,sizeof(pre),out);return true; }

static void set_calibration(evidence_t *e) {
    char material[128];
    e->calibration_revision = e->snapshot.calibration_revision;
    int n = snprintf(material, sizeof(material), "AIR-CAL-1|co_r0_q10000=%lld|no2_r0_q10000=%lld|revision=%lu",
                     (long long)e->snapshot.co_r0_q10000,
                     (long long)e->snapshot.no2_r0_q10000,
                     (unsigned long)e->calibration_revision);
    if (n < 0 || n >= (int)sizeof(material)) {
        memset(e->calibration_hash, 0, sizeof(e->calibration_hash));
        return;
    }
#ifdef INCIDENT_HOST_TEST
    SHA256((const unsigned char *)material, (size_t)n, e->calibration_hash);
#else
    (void)mbedtls_sha256((const unsigned char *)material, (size_t)n, e->calibration_hash, 0);
#endif
}

#if !defined(INCIDENT_HOST_TEST) || defined(INCIDENT_HOST_PERSISTENCE_TEST)
static esp_err_t nvs_open_rw(nvs_handle_t *h) { return nvs_open(INCIDENT_NS,NVS_READWRITE,h); }
static esp_err_t next_sequence(uint64_t *out) { nvs_handle_t h;esp_err_t err=nvs_open_rw(&h);if(err!=ESP_OK)return err;uint64_t v=0;err=nvs_get_u64(h,INCIDENT_KEY_SEQ,&v);if(err==ESP_ERR_NVS_NOT_FOUND)err=ESP_OK;if(err==ESP_OK && v!=UINT64_MAX){v++;err=nvs_set_u64(h,INCIDENT_KEY_SEQ,v);if(err==ESP_OK)err=nvs_commit(h);if(err==ESP_OK)*out=v;}else if(v==UINT64_MAX)err=ESP_ERR_INVALID_STATE;nvs_close(h);return err; }
static void key_for_slot(unsigned i,char out[8]) { snprintf(out,8,"q%u",i); }
static esp_err_t save_record(unsigned i,const queued_record_t *r) { nvs_handle_t h;char key[8];queued_record_t stored=*r;stored.checksum=record_checksum(&stored);key_for_slot(i,key);esp_err_t err=nvs_open_rw(&h);if(err==ESP_OK){err=nvs_set_blob(h,key,&stored,sizeof(stored));if(err==ESP_OK)err=nvs_commit(h);nvs_close(h);}return err; }
static bool load_record(unsigned i,queued_record_t *r) { nvs_handle_t h;char key[8];key_for_slot(i,key);size_t len=sizeof(*r);if(nvs_open(INCIDENT_NS,NVS_READONLY,&h)!=ESP_OK)return false;esp_err_t e=nvs_get_blob(h,key,r,&len);nvs_close(h);return e==ESP_OK&&len==sizeof(*r)&&r->magic==INCIDENT_MAGIC&&r->len<INCIDENT_PAYLOAD_MAX&&r->payload[r->len]==0&&r->checksum==record_checksum(r); }
static esp_err_t erase_record(unsigned i) { nvs_handle_t h;char key[8];key_for_slot(i,key);esp_err_t e=nvs_open_rw(&h);if(e==ESP_OK){e=nvs_erase_key(h,key);if(e==ESP_ERR_NVS_NOT_FOUND)e=ESP_OK;if(e==ESP_OK)e=nvs_commit(h);nvs_close(h);}return e; }
static int find_empty(void) { queued_record_t r;for(unsigned i=0;i<INCIDENT_QUEUE_CAPACITY;i++)if(!load_record(i,&r))return (int)i;return -1; }

#if !defined(INCIDENT_HOST_TEST) && CONFIG_SA_INCIDENT_OFFLINE_BENCH
static const char *INC_BENCH_TAG = "INC_BENCH";
static const char *INC_BENCH_PAYLOAD_TAG = "INC_BENCH_PAYLOAD";

static unsigned bench_queue_depth(void)
{
    unsigned depth = 0;
    queued_record_t record;
    for (unsigned i = 0; i < INCIDENT_QUEUE_CAPACITY; ++i) {
        if (load_record(i, &record)) depth++;
    }
    return depth;
}

static void bench_signature_hex(const uint8_t signature[65], char out[133])
{
    static const char hex[] = "0123456789abcdef";
    out[0] = '0';
    out[1] = 'x';
    for (unsigned i = 0; i < 65; ++i) {
        out[2 + i * 2] = hex[signature[i] >> 4];
        out[3 + i * 2] = hex[signature[i] & 0x0f];
    }
    out[132] = '\0';
}

static void bench_log_record(const char *state, const queued_record_t *record, bool include_payload)
{
    char incident_id[67], evidence_hash[67], signature[133];
    hex32(record->incident_id, incident_id);
    hex32(record->evidence_hash, evidence_hash);
    bench_signature_hex(record->signature, signature);
    ESP_LOGI(INC_BENCH_TAG, "%s queued incident", state);
    ESP_LOGI(INC_BENCH_TAG, "sequence=%llu", (unsigned long long)record->sequence);
    ESP_LOGI(INC_BENCH_TAG, "incident_id=%s", incident_id);
    ESP_LOGI(INC_BENCH_TAG, "evidence_hash=%s", evidence_hash);
    ESP_LOGI(INC_BENCH_TAG, "signature=%s", signature);
    if (include_payload) ESP_LOGI(INC_BENCH_PAYLOAD_TAG, "%s", record->payload);
}

static void bench_log_restored_records(void)
{
    unsigned depth = 0;
    queued_record_t *record = malloc(sizeof(*record));
    if (record == NULL) {
        ESP_LOGE(INC_BENCH_TAG, "restored-record inspection skipped: no memory");
        return;
    }
    for (unsigned i = 0; i < INCIDENT_QUEUE_CAPACITY; ++i) {
        if (load_record(i, record)) {
            bench_log_record("restored", record, true);
            depth++;
        }
    }
    free(record);
    ESP_LOGI(INC_BENCH_TAG, "queue_depth=%u", depth);
}
#endif

/* Key provisioning is intentionally disabled unless encrypted NVS is in the
 * generated sdkconfig. This prevents an accidental plaintext private key. */
static bool signer_available(void) {
#ifdef INCIDENT_HOST_PERSISTENCE_TEST
 return true;
#elif CONFIG_NVS_ENCRYPTION
    nvs_handle_t h;
    size_t n = 32;
    uint8_t key[32] = {0};
    esp_err_t e = nvs_open(INCIDENT_NS, NVS_READONLY, &h);
    if (e != ESP_OK) {
        ESP_LOGW(TAG, "signer namespace open failed: %s", esp_err_to_name(e));
        return false;
    }
    e = nvs_get_blob(h, INCIDENT_KEY_SIGNER, key, &n);
    nvs_close(h);
    memset(key, 0, sizeof(key));
    if (e == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGW(TAG, "signer key not found");
        return false;
    }
    if (e != ESP_OK) {
        ESP_LOGW(TAG, "signer blob read failed: %s (length=%u)",
                 esp_err_to_name(e), (unsigned)n);
        return false;
    }
    if (n != sizeof(key)) {
        ESP_LOGW(TAG, "signer blob invalid length: %u", (unsigned)n);
        return false;
    }
    return true;
#else
    ESP_LOGW(TAG, "signer unavailable: encrypted NVS is not enabled");
    return false;
#endif
}
static esp_err_t load_private_key(uint8_t key[32]) {
#if CONFIG_NVS_ENCRYPTION
    nvs_handle_t h; size_t n=32; esp_err_t e=nvs_open(INCIDENT_NS,NVS_READONLY,&h);
    if(e==ESP_OK){e=nvs_get_blob(h,INCIDENT_KEY_SIGNER,key,&n);nvs_close(h);}
    return e==ESP_OK&&n==32?ESP_OK:ESP_ERR_INVALID_STATE;
#else
    (void)key; return ESP_ERR_NOT_SUPPORTED;
#endif
}
#endif /* production or persistence-host NVS helpers */

/* This is deliberately shared by the firmware signer and the host vector
 * test.  The test supplies its public Hardhat fixture key at runtime; no test
 * key is compiled into the firmware image. */
#if !defined(INCIDENT_HOST_TEST) || defined(INCIDENT_HOST_CRYPTO_TEST)
static esp_err_t mpi_to_32(const mbedtls_mpi *v,uint8_t out[32]) { return mbedtls_mpi_write_binary(v,out,32)==0?ESP_OK:ESP_FAIL; }
static int secp256k1_generator(mbedtls_ecp_group *group, mbedtls_ecp_point *generator)
{
    static const uint8_t encoded[65] = {
        0x04,
        0x79,0xbe,0x66,0x7e,0xf9,0xdc,0xbb,0xac,0x55,0xa0,0x62,0x95,0xce,0x87,0x0b,0x07,
        0x02,0x9b,0xfc,0xdb,0x2d,0xce,0x28,0xd9,0x59,0xf2,0x81,0x5b,0x16,0xf8,0x17,0x98,
        0x48,0x3a,0xda,0x77,0x26,0xa3,0xc4,0x65,0x5d,0xa4,0xfb,0xfc,0x0e,0x11,0x08,0xa8,
        0xfd,0x17,0xb4,0x48,0xa6,0x85,0x54,0x19,0x9c,0x47,0xd0,0x8f,0xfb,0x10,0xd4,0xb8,
    };
    return mbedtls_ecp_point_read_binary(group, generator, encoded, sizeof(encoded));
}

static int secp256k1_order(mbedtls_mpi *order)
{
    static const uint8_t encoded[32] = {
        0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xfe,
        0xba,0xae,0xdc,0xe6,0xaf,0x48,0xa0,0x3b,0xbf,0xd2,0x5e,0x8c,0xd0,0x36,0x41,0x41,
    };
    return mbedtls_mpi_read_binary(order, encoded, sizeof(encoded));
}

static esp_err_t sign_digest_with_private_key(const uint8_t digest[32], const uint8_t key[32], uint8_t sig[65]) {
    mbedtls_ecp_group g; mbedtls_mpi d,r,s,e,k,tmp,inv,order,half; mbedtls_ecp_point R,G;
    mbedtls_entropy_context entropy; mbedtls_ctr_drbg_context rng;
    mbedtls_ecp_group_init(&g);mbedtls_mpi_init(&d);mbedtls_mpi_init(&r);mbedtls_mpi_init(&s);mbedtls_mpi_init(&e);mbedtls_mpi_init(&k);mbedtls_mpi_init(&tmp);mbedtls_mpi_init(&inv);mbedtls_mpi_init(&order);mbedtls_mpi_init(&half);mbedtls_ecp_point_init(&R);mbedtls_ecp_point_init(&G);mbedtls_entropy_init(&entropy);mbedtls_ctr_drbg_init(&rng);
    int rc=mbedtls_ecp_group_load(&g,MBEDTLS_ECP_DP_SECP256K1);
    if(!rc)rc=mbedtls_mpi_read_binary(&d,key,32);
    if(!rc)rc=secp256k1_order(&order);
    if(!rc)rc=secp256k1_generator(&g,&G);
    if(!rc)rc=mbedtls_ctr_drbg_seed(&rng,mbedtls_entropy_func,&entropy,(const unsigned char *)"incident",8);
    if(!rc)rc=mbedtls_ecdsa_sign_det_ext(&g,&r,&s,&d,digest,32,MBEDTLS_MD_SHA256,mbedtls_ctr_drbg_random,&rng);
    /* Solidity requires low-s. k is recovered from d/r/s/digest afterwards,
       which yields the correct parity even if low-s normalization flips s. */
    if(!rc){rc=mbedtls_mpi_copy(&half,&order);if(!rc)rc=mbedtls_mpi_shift_r(&half,1);if(!rc&&mbedtls_mpi_cmp_mpi(&s,&half)>0)rc=mbedtls_mpi_sub_mpi(&s,&order,&s);}
    if(!rc)rc=mbedtls_mpi_read_binary(&e,digest,32);
    if(!rc)rc=mbedtls_mpi_mod_mpi(&e,&e,&order);
    if(!rc)rc=mbedtls_mpi_mul_mpi(&tmp,&r,&d);
    if(!rc)rc=mbedtls_mpi_add_mpi(&tmp,&tmp,&e);
    if(!rc)rc=mbedtls_mpi_mod_mpi(&tmp,&tmp,&order);
    if(!rc)rc=mbedtls_mpi_inv_mod(&inv,&s,&order);
    if(!rc)rc=mbedtls_mpi_mul_mpi(&k,&tmp,&inv);
    if(!rc)rc=mbedtls_mpi_mod_mpi(&k,&k,&order);
    if(!rc)rc=mbedtls_ecp_mul(&g,&R,&k,&G,mbedtls_ctr_drbg_random,&rng);
    uint8_t compressed[33]; size_t compressed_len=0;
    if(!rc)rc=mbedtls_ecp_point_write_binary(&g,&R,MBEDTLS_ECP_PF_COMPRESSED,&compressed_len,compressed,sizeof(compressed));
    if(!rc&&compressed_len!=33)rc=MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    if(!rc)rc=mpi_to_32(&r,sig)==ESP_OK&&mpi_to_32(&s,sig+32)==ESP_OK?0:MBEDTLS_ERR_MPI_BUFFER_TOO_SMALL;
    if(!rc)sig[64]=(uint8_t)(27+(compressed[0]&1u));
    mbedtls_ctr_drbg_free(&rng);mbedtls_entropy_free(&entropy);mbedtls_ecp_point_free(&G);mbedtls_ecp_point_free(&R);mbedtls_mpi_free(&half);mbedtls_mpi_free(&order);mbedtls_mpi_free(&inv);mbedtls_mpi_free(&tmp);mbedtls_mpi_free(&k);mbedtls_mpi_free(&e);mbedtls_mpi_free(&s);mbedtls_mpi_free(&r);mbedtls_mpi_free(&d);mbedtls_ecp_group_free(&g);
    return rc==0?ESP_OK:ESP_FAIL;
}

#ifdef INCIDENT_HOST_CRYPTO_TEST
/* Recover Q = r^-1 (sR - eG) from an Ethereum compact ECDSA signature.
 * EIP-712 transport permits only recovery IDs 0/1 (v 27/28), so x is r; the
 * rarely possible x=r+n branch is intentionally not representable here. */
static esp_err_t recover_public_key(const uint8_t digest[32], const uint8_t sig[65], uint8_t public_key[65])
{
    static const uint8_t seven[] = { 7 };
    mbedtls_ecp_group group;
    mbedtls_ecp_point R, Q;
    mbedtls_mpi r, s, e, x, y, alpha, exponent, inverse, u1, u2, order, check;
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context rng;
    int rc = 0;
    size_t written = 0;

    if (sig[64] != 27 && sig[64] != 28) return ESP_ERR_INVALID_ARG;
    mbedtls_ecp_group_init(&group); mbedtls_ecp_point_init(&R); mbedtls_ecp_point_init(&Q);
    mbedtls_mpi_init(&r); mbedtls_mpi_init(&s); mbedtls_mpi_init(&e); mbedtls_mpi_init(&x);
    mbedtls_mpi_init(&y); mbedtls_mpi_init(&alpha); mbedtls_mpi_init(&exponent);
    mbedtls_mpi_init(&inverse); mbedtls_mpi_init(&u1); mbedtls_mpi_init(&u2);
    mbedtls_mpi_init(&order); mbedtls_mpi_init(&check);
    mbedtls_entropy_init(&entropy); mbedtls_ctr_drbg_init(&rng);

    rc = mbedtls_ecp_group_load(&group, MBEDTLS_ECP_DP_SECP256K1);
    if (!rc) rc = secp256k1_order(&order);
    if (!rc) rc = mbedtls_mpi_read_binary(&r, sig, 32);
    if (!rc) rc = mbedtls_mpi_read_binary(&s, sig + 32, 32);
    if (!rc && (mbedtls_mpi_cmp_int(&r, 0) <= 0 || mbedtls_mpi_cmp_mpi(&r, &order) >= 0 ||
                mbedtls_mpi_cmp_int(&s, 0) <= 0 || mbedtls_mpi_cmp_mpi(&s, &order) >= 0)) {
        rc = MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    }
    if (!rc) rc = mbedtls_mpi_copy(&check, &order);
    if (!rc) rc = mbedtls_mpi_shift_r(&check, 1);
    if (!rc && mbedtls_mpi_cmp_mpi(&s, &check) > 0) rc = MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    /* alpha = x^3 + 7 (mod p), y = alpha^((p + 1) / 4) (mod p).  secp256k1
     * has p % 4 == 3, so this is its canonical square-root operation. */
    if (!rc) rc = mbedtls_mpi_copy(&x, &r);
    if (!rc && mbedtls_mpi_cmp_mpi(&x, &group.P) >= 0) rc = MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    if (!rc) rc = mbedtls_mpi_mul_mpi(&alpha, &x, &x);
    if (!rc) rc = mbedtls_mpi_mod_mpi(&alpha, &alpha, &group.P);
    if (!rc) rc = mbedtls_mpi_mul_mpi(&alpha, &alpha, &x);
    if (!rc) rc = mbedtls_mpi_mod_mpi(&alpha, &alpha, &group.P);
    if (!rc) rc = mbedtls_mpi_add_int(&alpha, &alpha, seven[0]);
    if (!rc) rc = mbedtls_mpi_mod_mpi(&alpha, &alpha, &group.P);
    if (!rc) rc = mbedtls_mpi_add_int(&exponent, &group.P, 1);
    if (!rc) rc = mbedtls_mpi_shift_r(&exponent, 2);
    if (!rc) rc = mbedtls_mpi_exp_mod(&y, &alpha, &exponent, &group.P, NULL);
    if (!rc) rc = mbedtls_mpi_mul_mpi(&check, &y, &y);
    if (!rc) rc = mbedtls_mpi_mod_mpi(&check, &check, &group.P);
    if (!rc && mbedtls_mpi_cmp_mpi(&check, &alpha) != 0) rc = MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    if (!rc && ((mbedtls_mpi_get_bit(&y, 0) != 0) != ((sig[64] - 27) != 0))) {
        rc = mbedtls_mpi_sub_mpi(&y, &group.P, &y);
    }
    if (!rc) rc = mbedtls_mpi_copy(&R.MBEDTLS_PRIVATE(X), &x);
    if (!rc) rc = mbedtls_mpi_copy(&R.MBEDTLS_PRIVATE(Y), &y);
    if (!rc) rc = mbedtls_mpi_lset(&R.MBEDTLS_PRIVATE(Z), 1);
    if (!rc) rc = mbedtls_ecp_check_pubkey(&group, &R);
    if (!rc) rc = mbedtls_ctr_drbg_seed(&rng, mbedtls_entropy_func, &entropy,
                                         (const unsigned char *)"incident-recover", 16);
    /* secp256k1 has cofactor one: a non-infinite point which passed the curve
     * equation check is in the generator subgroup. mbedTLS rejects scalar n
     * in ecp_mul(), so do not attempt an nR check here. */
    if (!rc) rc = mbedtls_mpi_read_binary(&e, digest, 32);
    if (!rc) rc = mbedtls_mpi_mod_mpi(&e, &e, &order);
    if (!rc) rc = mbedtls_mpi_inv_mod(&inverse, &r, &order);
    if (!rc) rc = mbedtls_mpi_mul_mpi(&u1, &e, &inverse);
    if (!rc) rc = mbedtls_mpi_mod_mpi(&u1, &u1, &order);
    if (!rc && mbedtls_mpi_cmp_int(&u1, 0) != 0) rc = mbedtls_mpi_sub_mpi(&u1, &order, &u1);
    if (!rc) rc = mbedtls_mpi_mul_mpi(&u2, &s, &inverse);
    if (!rc) rc = mbedtls_mpi_mod_mpi(&u2, &u2, &order);
    if (!rc) rc = mbedtls_ecp_muladd(&group, &Q, &u1, &group.G, &u2, &R);
    if (!rc) rc = mbedtls_ecp_point_write_binary(&group, &Q, MBEDTLS_ECP_PF_UNCOMPRESSED,
                                                   &written, public_key, 65);
    if (!rc && written != 65) rc = MBEDTLS_ERR_ECP_BAD_INPUT_DATA;

    mbedtls_ctr_drbg_free(&rng); mbedtls_entropy_free(&entropy);
    mbedtls_mpi_free(&check); mbedtls_mpi_free(&order); mbedtls_mpi_free(&u2); mbedtls_mpi_free(&u1);
    mbedtls_mpi_free(&inverse); mbedtls_mpi_free(&exponent); mbedtls_mpi_free(&alpha); mbedtls_mpi_free(&y);
    mbedtls_mpi_free(&x); mbedtls_mpi_free(&e); mbedtls_mpi_free(&s); mbedtls_mpi_free(&r);
    mbedtls_ecp_point_free(&Q); mbedtls_ecp_point_free(&R); mbedtls_ecp_group_free(&group);
    return rc == 0 ? ESP_OK : ESP_FAIL;
}

static bool signature_has_low_s(const uint8_t sig[65])
{
    mbedtls_mpi s, order, half;
    int rc;
    mbedtls_mpi_init(&s); mbedtls_mpi_init(&order); mbedtls_mpi_init(&half);
    rc = secp256k1_order(&order);
    if (!rc) rc = mbedtls_mpi_read_binary(&s, sig + 32, 32);
    if (!rc) rc = mbedtls_mpi_copy(&half, &order);
    if (!rc) rc = mbedtls_mpi_shift_r(&half, 1);
    bool valid = !rc && mbedtls_mpi_cmp_int(&s, 0) > 0 && mbedtls_mpi_cmp_mpi(&s, &half) <= 0;
    mbedtls_mpi_free(&half); mbedtls_mpi_free(&order); mbedtls_mpi_free(&s);
    return valid;
}
#endif /* INCIDENT_HOST_CRYPTO_TEST */
#endif /* production or crypto host test */

#if !defined(INCIDENT_HOST_TEST) || defined(INCIDENT_HOST_PERSISTENCE_TEST)
static esp_err_t sign_digest(const uint8_t digest[32],uint8_t sig[65]) {
#ifdef INCIDENT_HOST_PERSISTENCE_TEST
    return incident_test_sign_digest(digest, sig);
#else
    uint8_t key[32]; if(load_private_key(key)!=ESP_OK)return ESP_ERR_INVALID_STATE;
    esp_err_t err = sign_digest_with_private_key(digest, key, sig);
    memset(key, 0, sizeof(key));
    return err;
#endif
}
#endif /* production or persistence-host signing wrapper */

static bool transition_allowed(uint8_t a,uint8_t b) { return (a==0&& (b==1||b==2)) || (a==1&&b==2); }
static bool trigger_valid(uint8_t level,const incident_snapshot_t *s) { if(level==2) return (s->co_level==2 && (s->sensor_valid_mask&4)) || (s->no2_level==2 && (s->sensor_valid_mask&8)); return (s->co_level==1 && (s->sensor_valid_mask&4)) || (s->no2_level==1 && (s->sensor_valid_mask&8)); }

/* Pure canonicalization is shared with host codec tests. */
static void canonicalize_snapshot(incident_snapshot_t *s)
{
    s->sensor_valid_mask &= 0x0fu;
    if ((s->sensor_valid_mask & 1u) == 0) s->temperature_c_x100 = 0;
    if ((s->sensor_valid_mask & 2u) == 0) s->humidity_pct_x100 = 0;
    if ((s->sensor_valid_mask & 4u) == 0) s->co_ppm_x1000 = 0;
    if ((s->sensor_valid_mask & 8u) == 0) s->no2_ppm_x1000 = 0;
    s->co_alarm_source_mask &= 0x07u;
    s->no2_alarm_source_mask &= 0x07u;
    s->derived_valid_mask &= 0x3fu;
    uint32_t *derived[] = {&s->co_stel15_ppm_x1000, &s->no2_stel15_ppm_x1000,
                           &s->co_twa8h_ppm_x1000, &s->no2_twa8h_ppm_x1000,
                           &s->co_proj10_ppm_x1000, &s->no2_proj10_ppm_x1000};
    for (unsigned i = 0; i < 6; ++i) if ((s->derived_valid_mask & (1u << i)) == 0) *derived[i] = 0;
    s->model_probability_valid_mask &= 0x03u;
    if ((s->model_probability_valid_mask & 1u) == 0) s->co_model_probability_bps = 0;
    if ((s->model_probability_valid_mask & 2u) == 0) s->no2_model_probability_bps = 0;
}

/* This gate is intentionally before the worker queue.  It is the single
 * production decision point for candidate creation and is also host-tested. */
static bool prepare_incident_work(uint8_t previous_level, uint8_t new_level,
                                  const incident_snapshot_t *snapshot, work_t *work)
{
    if (snapshot == NULL || work == NULL) return false;
    incident_snapshot_t canonical = *snapshot;
    canonicalize_snapshot(&canonical);
    if (!transition_allowed(previous_level, new_level) || canonical.warmup ||
        canonical.time_source == INCIDENT_TIME_NONE || canonical.observed_at == 0 ||
        canonical.overall_level != new_level || !trigger_valid(new_level, &canonical)) return false;
    work->previous_level = previous_level;
    work->new_level = new_level;
    work->snapshot = canonical;
    return true;
}

static void incident_kind_and_severity(uint8_t level, uint8_t *kind, uint8_t *severity)
{
    *kind = level == 1 ? 1 : 2;
    *severity = level == 1 ? 1 : 2;
}

#if !defined(INCIDENT_HOST_TEST) || defined(INCIDENT_HOST_PERSISTENCE_TEST)
static void set_model_hash(evidence_t *e) { memcpy(e->model_sha256, e->snapshot.model_sha256, sizeof(e->model_sha256)); }
static bool make_payload(const evidence_t *e, const uint8_t evh[32], const uint8_t sig[65], queued_record_t *r)
{
    char dh[67], ih[67], eh[67], fh[67], mh[67], ch[67], sh[132];
    hex32(e->device_id_hash, dh);
    hex32(e->incident_id, ih);
    hex32(evh, eh);
    hex32(e->firmware_version_hash, fh);
    hex32(e->model_sha256, mh);
    hex32(e->calibration_hash, ch);
    static const char hx[] = "0123456789abcdef";
    sh[0] = '0'; sh[1] = 'x';
    for (int i = 0; i < 65; i++) { sh[2 + i * 2] = hx[sig[i] >> 4]; sh[3 + i * 2] = hx[sig[i] & 15]; }
    sh[132] = 0;
    int n = snprintf(r->payload, sizeof(r->payload), "{\"schema_version\":2,\"device_id\":\"%s\",\"firmware_version\":\"%s\",\"device_id_hash\":\"%s\",\"incident_id\":\"%s\",\"sequence\":\"%llu\",\"observed_at\":\"%llu\",\"time_source\":%u,\"sensor_valid_mask\":%u,\"detection_method\":2,\"temperature_c_x100\":%ld,\"humidity_pct_x100\":%u,\"co_ppm_x1000\":%lu,\"no2_ppm_x1000\":%lu,\"overall_level\":%u,\"co_level\":%u,\"no2_level\":%u,\"co_alarm_source_mask\":%u,\"no2_alarm_source_mask\":%u,\"derived_valid_mask\":%u,\"co_stel15_ppm_x1000\":%lu,\"no2_stel15_ppm_x1000\":%lu,\"co_twa8h_ppm_x1000\":%lu,\"no2_twa8h_ppm_x1000\":%lu,\"co_proj10_ppm_x1000\":%lu,\"no2_proj10_ppm_x1000\":%lu,\"model_probability_valid_mask\":%u,\"co_model_probability_bps\":%u,\"no2_model_probability_bps\":%u,\"incident_kind\":%u,\"severity\":%u,\"firmware_version_hash\":\"%s\",\"model_sha256\":\"%s\",\"calibration_revision\":%lu,\"calibration_hash\":\"%s\",\"evidence_hash\":\"%s\",\"signature\":\"%s\"}", s_device_id, FIRMWARE_VERSION, dh, ih, (unsigned long long)e->sequence, (unsigned long long)e->observed_at, e->time_source, e->snapshot.sensor_valid_mask, (long)e->snapshot.temperature_c_x100, e->snapshot.humidity_pct_x100, (unsigned long)e->snapshot.co_ppm_x1000, (unsigned long)e->snapshot.no2_ppm_x1000, e->snapshot.overall_level, e->snapshot.co_level, e->snapshot.no2_level, e->snapshot.co_alarm_source_mask, e->snapshot.no2_alarm_source_mask, e->snapshot.derived_valid_mask, (unsigned long)e->snapshot.co_stel15_ppm_x1000, (unsigned long)e->snapshot.no2_stel15_ppm_x1000, (unsigned long)e->snapshot.co_twa8h_ppm_x1000, (unsigned long)e->snapshot.no2_twa8h_ppm_x1000, (unsigned long)e->snapshot.co_proj10_ppm_x1000, (unsigned long)e->snapshot.no2_proj10_ppm_x1000, e->snapshot.model_probability_valid_mask, e->snapshot.co_model_probability_bps, e->snapshot.no2_model_probability_bps, e->incident_kind, e->severity, fh, mh, (unsigned long)e->calibration_revision, ch, eh, sh);
    if (n < 0 || n >= (int)sizeof(r->payload)) return false;
    r->len = (uint16_t)n;
    return true;
}

static void process_work(const work_t *w)
{
    work_t checked;
    if (!prepare_incident_work(w->previous_level, w->new_level, &w->snapshot, &checked)) return;
    incident_snapshot_t snapshot = checked.snapshot;
    if (!signer_available()) {
        ESP_LOGW(TAG, "incident skipped: no encrypted provisioned signer");
#if !defined(INCIDENT_HOST_TEST) && CONFIG_SA_INCIDENT_OFFLINE_BENCH
        ESP_LOGW(INC_BENCH_TAG, "production signer unavailable; signing cannot proceed");
#endif
        return;
    }

    /* A queued record is 2208 bytes. Keep it off this 6144-byte worker stack:
     * persistence helpers also need a full-record scratch frame. */
    queued_record_t *record = calloc(1, sizeof(*record));
    if (record == NULL) {
        ESP_LOGE(TAG, "incident workspace allocation failed");
        return;
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    int slot = find_empty();
    if (slot < 0) {
        s_queue_full_count++;
        xSemaphoreGive(s_lock);
        free(record);
        ESP_LOGW(TAG, "incident queue full (count=%lu)", (unsigned long)s_queue_full_count);
#if !defined(INCIDENT_HOST_TEST) && CONFIG_SA_INCIDENT_OFFLINE_BENCH
        ESP_LOGW(INC_BENCH_TAG, "incident queue full; local safety unaffected");
#endif
        return;
    }

    uint8_t kind, severity;
    incident_kind_and_severity(checked.new_level, &kind, &severity);
    evidence_t e = {.schema_version = 2,
                    .time_source = snapshot.time_source,
                    .snapshot = snapshot,
                    .incident_kind = kind,
                    .severity = severity};
    e.observed_at = snapshot.observed_at;
    keccak256(s_device_id, strlen(s_device_id), e.device_id_hash);
    if (next_sequence(&e.sequence) != ESP_OK) {
        xSemaphoreGive(s_lock);
        free(record);
        ESP_LOGE(TAG, "sequence persistence failed");
        return;
    }
#if !defined(INCIDENT_HOST_TEST) && CONFIG_SA_INCIDENT_OFFLINE_BENCH
    ESP_LOGI(INC_BENCH_TAG, "sequence=%llu", (unsigned long long)e.sequence);
#endif

    hash_incident_id(e.device_id_hash, e.sequence, e.incident_id);
    keccak256(FIRMWARE_VERSION, strlen(FIRMWARE_VERSION), e.firmware_version_hash);
    set_model_hash(&e);
    set_calibration(&e);
    uint8_t evh[32], digest[32], sig[65];
    hash_evidence(&e, evh);
#if !defined(INCIDENT_HOST_TEST) && CONFIG_SA_INCIDENT_OFFLINE_BENCH
    char incident_id_hex[67], evidence_hash_hex[67];
    hex32(e.incident_id, incident_id_hex);
    hex32(evh, evidence_hash_hex);
    ESP_LOGI(INC_BENCH_TAG, "incident_id=%s", incident_id_hex);
    ESP_LOGI(INC_BENCH_TAG, "evidence_hash=%s", evidence_hash_hex);
#endif
    if (!hash_digest(&e, evh, digest) || sign_digest(digest, sig) != ESP_OK) {
        xSemaphoreGive(s_lock);
        free(record);
        ESP_LOGW(TAG, "incident signing unavailable; sequence retained without reuse");
        return;
    }
#if !defined(INCIDENT_HOST_TEST) && CONFIG_SA_INCIDENT_OFFLINE_BENCH
    char signature_hex[133];
    bench_signature_hex(sig, signature_hex);
    ESP_LOGI(INC_BENCH_TAG, "signature created");
    ESP_LOGI(INC_BENCH_TAG, "signature=%s", signature_hex);
#endif

    record->magic = INCIDENT_MAGIC;
    record->sequence = e.sequence;
    memcpy(record->incident_id, e.incident_id, 32);
    memcpy(record->evidence_hash, evh, 32);
    memcpy(record->signature, sig, 65);
    if (!make_payload(&e, evh, sig, record) || save_record((unsigned)slot, record) != ESP_OK) {
        xSemaphoreGive(s_lock);
        free(record);
        ESP_LOGE(TAG, "incident durable persistence failed");
        return;
    }
#if !defined(INCIDENT_HOST_TEST) && CONFIG_SA_INCIDENT_OFFLINE_BENCH
    unsigned depth = bench_queue_depth();
    ESP_LOGI(INC_BENCH_TAG, "persisted");
    ESP_LOGI(INC_BENCH_TAG, "queue_depth=%u", depth);
    ESP_LOGI(INC_BENCH_PAYLOAD_TAG, "%s", record->payload);
#endif
    xSemaphoreGive(s_lock);

    int publish_result = mqtt_publish(s_topic, record->payload, 1, false);
    free(record);
    if (publish_result < 0) {
        ESP_LOGW(TAG, "incident queued offline");
#if !defined(INCIDENT_HOST_TEST) && CONFIG_SA_INCIDENT_OFFLINE_BENCH
        ESP_LOGW(INC_BENCH_TAG, "MQTT unavailable/offline; record retained");
#endif
    }
}

#ifndef INCIDENT_HOST_TEST
static void incident_task(void *arg) { (void)arg;work_t w;for(;;){if(xQueueReceive(s_work,&w,pdMS_TO_TICKS(60000))==pdTRUE)process_work(&w);incident_retry_pending();} }

esp_err_t incident_init(const char *device_id)
{
    if (!valid_device_id(device_id)) return ESP_ERR_INVALID_ARG;
    strlcpy(s_device_id, device_id, sizeof(s_device_id));
    snprintf(s_topic, sizeof(s_topic), "device/%s/incident", device_id);
    s_lock = xSemaphoreCreateMutex();
    s_work = xQueueCreate(INCIDENT_WORK_QUEUE_CAPACITY, sizeof(work_t));
    if (!s_lock || !s_work) return ESP_ERR_NO_MEM;
#if CONFIG_SA_INCIDENT_OFFLINE_BENCH
    bench_log_restored_records();
#endif
    return xTaskCreate(incident_task, "incident_task", INCIDENT_TASK_STACK, NULL,
                       INCIDENT_TASK_PRIORITY, NULL) == pdPASS ? ESP_OK : ESP_FAIL;
}
#endif

#if !defined(INCIDENT_HOST_TEST) || defined(INCIDENT_HOST_QUEUE_TEST)
void incident_set_time_source(incident_time_source_t source) { s_time_source=(source==INCIDENT_TIME_SNTP||source==INCIDENT_TIME_DS3231)?source:INCIDENT_TIME_NONE; }
void incident_on_gas_ews_transition(uint8_t a, uint8_t b, const incident_snapshot_t *s)
{
    if (!s || !s_work) return;
    time_t now = time(NULL);
    incident_time_source_t source = s_time_source;
    if (now <= 0 || source == INCIDENT_TIME_NONE) return;
    incident_snapshot_t snapshot = *s;
    snapshot.time_source = source;
    snapshot.observed_at = (uint64_t)now;
    work_t w;
    if (!prepare_incident_work(a, b, &snapshot, &w)) return;
    if (xQueueSend(s_work, &w, 0) != pdTRUE) {
        ESP_LOGW(TAG, "incident worker busy; local alert unaffected");
        return;
    }
#if !defined(INCIDENT_HOST_TEST) && CONFIG_SA_INCIDENT_OFFLINE_BENCH
    static const char *levels[] = {"SAFE", "EARLY_WARNING", "EXCEEDED"};
    ESP_LOGI(INC_BENCH_TAG, "transition %s->%s", levels[a], levels[b]);
    ESP_LOGI(INC_BENCH_TAG, "incident accepted");
#endif
}
#endif

void incident_retry_pending(void) { if(!s_lock)return;xSemaphoreTake(s_lock,portMAX_DELAY);for(unsigned i=0;i<INCIDENT_QUEUE_CAPACITY;i++){queued_record_t r;if(load_record(i,&r)){s_retry_count++;if(mqtt_publish(s_topic,r.payload,1,false)<0)break;}}xSemaphoreGive(s_lock); }

#if !defined(INCIDENT_HOST_TEST) || defined(INCIDENT_HOST_ACK_TEST)
esp_err_t incident_handle_ack(const char *payload)
{
    if (!payload || !s_lock) return ESP_ERR_INVALID_ARG;
    cJSON *o = cJSON_ParseWithOpts(payload, NULL, true);
    if (!cJSON_IsObject(o)) {
        cJSON_Delete(o);
        return ESP_ERR_INVALID_ARG;
    }
    cJSON *v = cJSON_GetObjectItemCaseSensitive(o, "schema_version");
    cJSON *a = cJSON_GetObjectItemCaseSensitive(o, "accepted");
    cJSON *id = cJSON_GetObjectItemCaseSensitive(o, "incident_id");
    cJSON *eh = cJSON_GetObjectItemCaseSensitive(o, "evidence_hash");
    cJSON *ec = cJSON_GetObjectItemCaseSensitive(o, "error_code");
    cJSON *ra = cJSON_GetObjectItemCaseSensitive(o, "received_at");
    uint8_t ih[32], hh[32];
    bool ok = cJSON_IsNumber(v) && v->valuedouble == 2.0 && cJSON_IsTrue(a) &&
              cJSON_IsString(id) && cJSON_IsString(eh) && cJSON_IsString(ec) &&
              cJSON_IsString(ra) && parse_hex32(id->valuestring, ih) &&
              parse_hex32(eh->valuestring, hh);
    esp_err_t result = ok ? ESP_OK : ESP_ERR_INVALID_ARG;
    if (ok) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        for (unsigned i = 0; i < INCIDENT_QUEUE_CAPACITY; i++) {
            queued_record_t r;
            if (load_record(i, &r) && memcmp(ih, r.incident_id, 32) == 0 &&
                memcmp(hh, r.evidence_hash, 32) == 0) {
                result = erase_record(i);
                break;
            }
        }
        xSemaphoreGive(s_lock);
    }
    cJSON_Delete(o);
    return result;
}
#endif

#ifndef INCIDENT_HOST_TEST
esp_err_t incident_provision_signer(const uint8_t key[32]) {
    if(!key)return ESP_ERR_INVALID_ARG;
#if CONFIG_NVS_ENCRYPTION
    nvs_handle_t h;esp_err_t e=nvs_open_rw(&h);if(e==ESP_OK){e=nvs_set_blob(h,INCIDENT_KEY_SIGNER,key,32);if(e==ESP_OK)e=nvs_commit(h);nvs_close(h);}return e;
#else
    return ESP_ERR_NOT_SUPPORTED;
#endif
}
esp_err_t incident_get_signer_address(char out[43]) {
    if(!out)return ESP_ERR_INVALID_ARG;
    uint8_t key[32],pub[65],hash[32];
    if(load_private_key(key)!=ESP_OK)return ESP_ERR_INVALID_STATE;
    mbedtls_ecp_group g;mbedtls_mpi d;mbedtls_ecp_point q,G;mbedtls_entropy_context entropy;mbedtls_ctr_drbg_context rng;size_t pub_len=0;
    mbedtls_ecp_group_init(&g);mbedtls_mpi_init(&d);mbedtls_ecp_point_init(&q);mbedtls_ecp_point_init(&G);mbedtls_entropy_init(&entropy);mbedtls_ctr_drbg_init(&rng);
    int rc=mbedtls_ecp_group_load(&g,MBEDTLS_ECP_DP_SECP256K1);
    if(!rc)rc=mbedtls_mpi_read_binary(&d,key,32);
    if(!rc)rc=secp256k1_generator(&g,&G);
    if(!rc)rc=mbedtls_ctr_drbg_seed(&rng,mbedtls_entropy_func,&entropy,(const unsigned char *)"incident",8);
    if(!rc)rc=mbedtls_ecp_mul(&g,&q,&d,&G,mbedtls_ctr_drbg_random,&rng);
    if(!rc)rc=mbedtls_ecp_point_write_binary(&g,&q,MBEDTLS_ECP_PF_UNCOMPRESSED,&pub_len,pub,sizeof(pub));
    if(!rc&&pub_len!=65)rc=MBEDTLS_ERR_ECP_BAD_INPUT_DATA;
    if(!rc){keccak256(pub+1,64,hash);static const char h[]="0123456789abcdef";out[0]='0';out[1]='x';for(int i=0;i<20;i++){out[2+i*2]=h[hash[12+i]>>4];out[3+i*2]=h[hash[12+i]&15];}out[42]=0;}
    mbedtls_ctr_drbg_free(&rng);mbedtls_entropy_free(&entropy);mbedtls_ecp_point_free(&G);mbedtls_ecp_point_free(&q);mbedtls_mpi_free(&d);mbedtls_ecp_group_free(&g);memset(key,0,sizeof(key));memset(pub,0,sizeof(pub));
    return rc==0?ESP_OK:ESP_FAIL;
}
esp_err_t incident_rotate_signer(const uint8_t key[32]) { if(find_empty()!=0)return ESP_ERR_INVALID_STATE;return incident_provision_signer(key); }
esp_err_t incident_revoke_local_signer(void) { nvs_handle_t h;esp_err_t e=nvs_open_rw(&h);if(e==ESP_OK){e=nvs_erase_key(h,INCIDENT_KEY_SIGNER);if(e==ESP_OK)e=nvs_commit(h);nvs_close(h);}return e; }
#endif /* !INCIDENT_HOST_TEST: task/API/signer lifecycle */
#endif /* production or persistence host processing */

#else
esp_err_t incident_init(const char *device_id){(void)device_id;return ESP_OK;} void incident_set_time_source(incident_time_source_t s){(void)s;} void incident_on_gas_ews_transition(uint8_t a,uint8_t b,const incident_snapshot_t*s){(void)a;(void)b;(void)s;} esp_err_t incident_handle_ack(const char*p){(void)p;return ESP_ERR_NOT_SUPPORTED;} void incident_retry_pending(void){} esp_err_t incident_provision_signer(const uint8_t k[32]){(void)k;return ESP_ERR_NOT_SUPPORTED;} esp_err_t incident_get_signer_address(char o[43]){(void)o;return ESP_ERR_NOT_SUPPORTED;} esp_err_t incident_rotate_signer(const uint8_t k[32]){(void)k;return ESP_ERR_NOT_SUPPORTED;} esp_err_t incident_revoke_local_signer(void){return ESP_ERR_NOT_SUPPORTED;}
#endif
