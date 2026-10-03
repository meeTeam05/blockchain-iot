# Chạy E2E khi đã được giao sẵn `server/.env`

Tài liệu này dành cho người **đã nhận file `server/.env` đã điền sẵn**, gồm RPC
Sepolia, khóa ví relayer và khóa ví device manager. Bạn **không** cần tạo ví,
xin cấp role, nạp ETH hay deploy contract. Bạn chỉ cần dựng server trên máy mình,
build firmware và chạy E2E.

Luồng E2E:

```text
ESP32 (ký EIP-712) → MQTT/WSS → EMQX → API (xác thực, outbox) → chain-worker (relayer)
  → AirSafetyLog trên Sepolia → indexer → API/app
```

| Mục | Giá trị |
|---|---|
| Contract | `0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A` ([Etherscan › Events](https://sepolia.etherscan.io/address/0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A#events)) |
| Ví relayer (trong `.env`) | `0xe9426f8AbFf21ddb99a4Ca383c2b71D9AF95197d` |
| Ví device manager (trong `.env`) | `0x106ce92E3664AeD1330c183aFdF2D5Ff7618D29A` |
| Nhánh git | `integration/task1-task2-task3` |

---

## ⚠️ 3 quy tắc trước khi bắt đầu

1. **Giữ `server/.env` bí mật.** File này chứa khóa ví có quyền gửi incident và đăng ký hoặc thu hồi device trên contract. Không commit, không gửi tiếp cho ai, không chụp màn hình. Test xong thì xóa file hoặc trả lại người giao.
2. **Cả hệ thống chỉ chạy MỘT chain-worker.** Người giao `.env` cũng có thể đang chạy worker với cùng 2 ví. Hai worker chạy cùng lúc sẽ tranh nonce và làm tx bị lỗi. Trước bước 2.7, nhắn người giao chạy `docker compose stop chain-worker` và **chờ họ xác nhận đã dừng**.
3. **Chỉ sửa 3 biến** trong `.env`: `MQTT_LAN_BIND_IP`, `OTA_PUBLIC_BASE_URL` và `CORS_ORIGINS`. Không sửa các biến `CHAIN_*`, `INCIDENT_*`, `RELAYER_*` hay `DEVICE_MANAGER_*`.

---

## 0. Chuẩn bị

### 0.1 Phần mềm (Windows)

| Phần mềm | Phiên bản | Ghi chú |
|---|---|---|
| Git for Windows | mới nhất | Kèm **Git Bash** (cần cho `sh`, `openssl`) |
| Node.js | **22 LTS** | |
| Docker Desktop | mới nhất | Phải đang chạy trước mọi lệnh `docker` |
| ESP-IDF | **v5.4.2** | Chỉ cần cho phần board (mục 3) |
| Android SDK, JDK 17, `adb` | | Chỉ cần để cài app Expo lên điện thoại (mục 3.6) |
| MetaMask | | Dùng làm ví **owner** của device. Không dùng ví relayer hay ví manager làm owner |

### 0.2 Lấy code

```powershell
git clone <repo-url> blockchain-iot
cd blockchain-iot
git checkout integration/task1-task2-task3
cd blockchain;  npm ci; cd ..
cd server\api;  npm ci; cd ..\..
node spec/incident/gen/gen-all.mjs --check
```

**Đạt:** lệnh cuối in ra `generated incident domain files are up to date`.

### 0.3 Đặt file `.env`

Chép file nhận được vào `server\.env`. Tên file đúng là `.env`, không phải `.env.txt`.

Kiểm tra các biến quan trọng đã có giá trị. Lệnh chỉ in tên biến, không in giá trị:

```powershell
cd server
Select-String -Path .env -Pattern '^(INCIDENT_DEPLOYMENT|CHAIN_RPC_URL|RELAYER_PRIVATE_KEY|DEVICE_MANAGER_PRIVATE_KEY|EMQX_API_KEY|EMQX_API_SECRET|JWT_SECRET)=.+' | ForEach-Object { $_.Line.Split('=')[0] + ' = (có)' }
```

**Đạt:** in đủ 7 dòng `… = (có)`. Thiếu dòng nào thì báo lại người giao `.env`.

### 0.4 Sửa `MQTT_LAN_BIND_IP`

Chạy `ipconfig` và lấy **IPv4 Address** của card Wi-Fi hoặc Ethernet đang dùng
(ví dụ `192.168.1.20`). Đặt vào `.env`:

```text
MQTT_LAN_BIND_IP=192.168.1.20
```

Sai IP thì EMQX sẽ kẹt ở `Starting` với lỗi `can't bind on the specified endpoint`.

---

## Mức 1: E2E trên chain local (5 phút, không cần Docker hay board)

Mức này kiểm tra code relayer, contract và indexer trên máy bạn trước.

```powershell
# Terminal 1: để yên, không tắt
cd blockchain
npx hardhat compile
npx hardhat node

# Terminal 2
cd server\api
$env:E2E_CHAIN_RPC_URL="http://127.0.0.1:8545"
node --test test/e2e/chain-e2e.test.js
```

**Đạt:** cuối output có `ℹ pass 12` và `ℹ fail 0`. Khi có ✖, chạy lại với
`$env:E2E_DEBUG="1"` rồi gửi log cho team. Chạy xong thì tắt terminal 1 (Ctrl+C).

---

## Mức 2: Dựng server Docker

Mọi lệnh chạy trong thư mục `server`.

### 2.1 Tạo 2 file bị gitignore (chạy trong **Git Bash**)

`.env` đã có sẵn khóa EMQX, nhưng 2 file dưới đây không có trong repo nên phải tự tạo:

```bash
cd /d/<đường-dẫn>/blockchain-iot/server

# 1) File API key cho EMQX, sinh từ EMQX_API_KEY / EMQX_API_SECRET trong .env
sh emqx/render-api-key-bootstrap.sh

# 2) Cert TLS self-signed. Thay 192.168.1.20 bằng MQTT_LAN_BIND_IP của bạn.
cd emqx && mkdir -p certs
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -keyout certs/server.key \
  -out certs/server.crt -days 3650 -nodes -subj "/CN=smart-air-emqx/O=SmartAir/C=VN" \
  -addext "subjectAltName=IP:192.168.1.20,IP:127.0.0.1,DNS:localhost"
cd ..
ls -la emqx/api-key.bootstrap emqx/certs
```

**Đạt:** `emqx/api-key.bootstrap` là **file** (không phải thư mục) và `emqx/certs` có `server.crt` cùng `server.key`.

Hai lỗi hay gặp:
- **`api-key.bootstrap` bị thành thư mục:** xảy ra khi lỡ chạy `docker compose up` trước bước này. Chạy `rmdir emqx/api-key.bootstrap`, rồi render lại.
- **openssl không ghi được file:** phải dùng đường dẫn tương đối như trên. `openssl` trên Git Bash không ghi được vào đường dẫn dạng `/d/...`.

### 2.2 Build và chạy (PowerShell)

```powershell
docker compose build api
docker compose up -d postgres redis emqx api nginx
```

Không chạy service `cloudflared` trong compose, vì token tunnel trong `.env` là của
người giao hoặc chỉ là placeholder. Bước 2.4 dùng quick tunnel riêng.

Container API tự chạy migration tới `019` trước khi khởi động.

### 2.3 Kiểm tra server

```powershell
docker compose ps
docker compose exec api wget -qO- http://127.0.0.1:3000/api/health/ready
docker compose logs api 2>&1 | Select-String '"level":50'
```

**Đạt:**
- `postgres`, `redis`, `emqx`, `api`, `nginx` đều `(healthy)`.
- Health trả về `{"status":"ok","checks":{"postgres":"ok","redis":"ok","emqx":"ok","mqtt":"ok","realtime":"ok"}}`.
- Lệnh thứ 3 in ra nhiều nhất **một** dòng `fetch failed` lúc khởi động (EMQX chưa sẵn sàng, API tự thử lại). Không được có lỗi `401` hay lỗi domain.

`docker compose logs -f …` chạy mãi không tự thoát, nhấn Ctrl+C để dừng.

### 2.4 Mở server ra Internet bằng quick tunnel

Board kiểm tra cert bằng CA công khai, nên không kết nối được EMQX trong LAN bằng cert self-signed. Cần tunnel:

```powershell
docker run -d --name sa-quicktunnel --network smart-air_sa-net cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://nginx:80
Start-Sleep 10
docker logs sa-quicktunnel 2>&1 | Select-String trycloudflare
```

Ghi lại URL `https://<tên>.trycloudflare.com`, sau đó:

1. Sửa `.env`:
   ```text
   OTA_PUBLIC_BASE_URL=https://<tên>.trycloudflare.com
   CORS_ORIGINS=https://<tên>.trycloudflare.com
   ```
2. Chạy `docker compose up -d api`.
3. **Đạt:** điện thoại dùng 4G (tắt Wi-Fi) mở `https://<tên>.trycloudflare.com/api/health/live` và nhận HTTP 200.

URL này **đổi mỗi lần** container `sa-quicktunnel` khởi động lại. Nếu URL đổi thì phải sửa lại `.env`, build lại app và provision lại board.

### 2.5 Test MQTT với Docker (không cần board)

Chạy ở thư mục gốc repo:

```powershell
cd ..
docker run --rm --network smart-air_sa-net --env-file server/.env -e E2E_API_URL=http://api:3000 -e E2E_MQTT_URL=mqtt://emqx:1883 -v "${PWD}:/repo" -w /repo/server/api node:20-alpine node --test test/e2e/incident-mqtt.e2e.test.js
cd server
```

**Đạt:** `fail 0`. Test tạo device ảo, ký incident rồi publish vào EMQX. Test chỉ kiểm tra backend, **không** gửi lên chain.

### 2.6 Kiểm tra ví còn ETH

Mở 2 link bên dưới. Mỗi ví nên còn **≥ 0.01 ETH**. Thiếu thì báo người giao `.env` để họ nạp thêm.
- Relayer: <https://sepolia.etherscan.io/address/0xe9426f8AbFf21ddb99a4Ca383c2b71D9AF95197d>
- Manager: <https://sepolia.etherscan.io/address/0x106ce92E3664AeD1330c183aFdF2D5Ff7618D29A>

### 2.7 Chạy chain-worker (chỉ sau khi người giao đã **dừng** worker của họ)

```powershell
docker compose --profile chain up -d chain-worker
Start-Sleep 20
docker compose ps chain-worker
docker compose logs --tail 20 chain-worker
```

**Đạt:**
- Trạng thái `Up`, không phải `Exited` hay `Restarting`.
- Log có `"msg":"chain worker started"` với:
  - `"contract":"0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A"`
  - `"relayer":"0xe9426f8AbFf21ddb99a4Ca383c2b71D9AF95197d"`
  - `"deviceManager":"0x106ce92E3664AeD1330c183aFdF2D5Ff7618D29A"`
- Log không có `"level":50`.

Worker thoát với **exit code 2** nghĩa là lỗi nghiêm trọng: mất role, hoặc domain hay RPC sai. Gửi log cho người giao `.env`.

---

## Mức 3: Board thật lên Sepolia

### 3.1 Cài ESP-IDF v5.4.2

Tải **ESP-IDF Windows Offline Installer v5.4.2** tại <https://dl.espressif.com/dl/esp-idf/>
và cài vào `C:\Espressif`. Mọi lệnh `idf.py` / `espefuse.py` chạy trong shortcut
**"ESP-IDF 5.4 PowerShell"**.

**Đạt:** `idf.py --version` in ra `v5.4.2`.

Cắm board ESP32-S3 (N16R8) bằng cáp USB có dây data. Xem cổng COM trong Device
Manager, mục *Ports (COM & LPT)*. Bên dưới dùng `COM5` làm ví dụ.

### 3.2 Build firmware (build không cần board)

```powershell
cd firmware
idf.py -B build-incident -D SDKCONFIG=sdkconfig.incident.generated -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident" build
Select-String "INCIDENT_ENV_SEPOLIA=y|NVS_ENCRYPTION=y|IDF_TARGET=" sdkconfig.incident.generated
```

**Đạt:** có `Project build complete`, và thấy `CONFIG_IDF_TARGET="esp32s3"`,
`CONFIG_SA_INCIDENT_ENV_SEPOLIA=y`, `CONFIG_NVS_ENCRYPTION=y`.

### 3.3 ⚠️ eFuse: đọc trước lần flash đầu

Firmware bật **NVS encryption** với khóa HMAC ở **eFuse key block 5**. Ở lần boot
đầu, ESP-IDF tự sinh khóa và ghi **vĩnh viễn** vào eFuse, **không đảo ngược được**.
NVS dạng thường cũ (Wi-Fi, secret MQTT) sẽ không đọc được nữa và phải provision lại.

```powershell
espefuse.py -p COM5 summary
```

Xem `BLOCK_KEY5` / `KEY_PURPOSE_5`. Chỉ tiếp tục khi chấp nhận board này dùng cố định cho dự án.

**Không bao giờ chạy `idf.py erase-flash`**, vì lệnh này xóa signer, sequence và queue incident.

### 3.4 Nạp khóa signer (mỗi board một lần)

Nếu board **đã có signer** (đã làm bước này trước đó), bỏ qua 3.4 và hỏi người
giao `.env` địa chỉ signer của board.

```powershell
idf.py -B build-signer -D SDKCONFIG=sdkconfig.signer.generated -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.signer-provision.bench" build
idf.py -B build-signer -p COM5 flash monitor
```

1. Chờ dòng `SIGNER_PROV: UART command ready; firmware input echo is disabled`.
2. Mở terminal khác và sinh khóa:
   ```powershell
   python -c "import secrets;n=int('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',16);print(f'{secrets.randbelow(n-1)+1:064x}')"
   ```
3. Trong monitor, dán `incident signer-provision <64 ký tự hex>` rồi nhấn Enter, **chỉ một lần**.
4. **Đạt:** log in `SIGNER_PROV: provisioning success` và `SIGNER_PROV: signer address=0x…`.
   **Ghi lại địa chỉ.** Không lưu private key, và xóa lịch sử terminal.
5. Nhấn EN/RESET và kiểm tra địa chỉ sau khi boot lại vẫn giống hệt. Thoát monitor bằng `Ctrl+]`.

### 3.5 Flash bản production (giữ NVS)

```powershell
idf.py -B build-incident -p COM5 app-flash monitor
```

**Đạt:** log boot có

```text
incident domain sepolia contract 0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A separator 0x34632810…
```

Nếu thay vào đó là lỗi domain hoặc log báo không ký thì **dừng lại** và báo team.

### 3.6 Build app và provision board

```powershell
cd app
npm install
$env:EXPO_PUBLIC_API_BASE_URL="https://<tên>.trycloudflare.com/api"
$env:EXPO_PUBLIC_MQTT_BROKER_URI="wss://<tên>.trycloudflare.com/mqtt"
npx expo run:android --variant release
```

Điện thoại cắm USB, đã bật USB debugging (`adb devices` thấy máy). Hai biến `EXPO_PUBLIC_*` được nhúng lúc build: đổi URL tunnel là phải build lại. Dùng domain cố định `minhnhat05.xyz` thì không cần đặt hai biến này (xem `docs/_RUN_BOOK.md`, mục A2).

Trên app: đăng ký tài khoản, thêm thiết bị qua BLE (tên `SMART_AIR_xxxxxx`), rồi nhập Wi-Fi.

**Đạt:**
- Log board báo đã kết nối MQTT.
- DB có device:
  ```powershell
  cd server
  docker compose exec postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT id FROM devices;"'
  ```
  `id` là MAC viết thường có dấu `:`, ví dụ `a1:b2:c3:d4:e5:f6`. Đây là `<device_id>`.

### 3.7 Đăng ký device lên contract

```powershell
docker compose exec api node scripts/device-signer.js register <device_id> <signer_address> --owner <ví_MetaMask_của_bạn>
```

Chờ khoảng 1–2 phút (3 confirmations), rồi kiểm tra:

```powershell
docker compose exec api node scripts/device-signer.js show <device_id>
docker compose logs --tail 20 chain-worker
```

**Đạt:**
- Signer ở trạng thái `active`, op `register` ở trạng thái `confirmed`.
- Log board có `signer activated; next sequence >= 1`.
- [Etherscan › Events](https://sepolia.etherscan.io/address/0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A#events) có event `DeviceRegistered` mới.

Nếu op `register` bị `failed` với lỗi kiểu `DeviceAlreadyActive` / `SignerAlreadyUsed`, board này
đã được đăng ký lên contract từ server khác. Hỏi người giao `.env`, vì phải dùng
`sync-chain` hoặc `rotate` từ phía họ.

Trước khi có floor, board bỏ qua incident và log
`incident skipped: signer awaiting signer_activate sequence floor`. Đây là hành vi đúng.

### 3.8 Tạo incident

Khi không có khí CO/NO₂ thật, flash bản **replay dữ liệu giả lập** (chỉ để test). Bản này vẫn chạy mạng thật:

```powershell
cd firmware
idf.py -B build-replay -D SDKCONFIG=sdkconfig.replay.generated -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.network-replay" build
idf.py -B build-replay -p COM5 app-flash monitor
```

**Đạt:** còi kêu, log báo incident được ký và publish, nhận ACK `accepted:true`, queue trống.

### 3.9 Kết luận ĐẠT hay KHÔNG ĐẠT

```powershell
cd server
docker compose exec postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT status, tx_hash, fail_reason FROM blockchain_outbox;"'
```

| `status` | Ý nghĩa |
|---|---|
| `confirmed` + có `tx_hash` | ✅ **E2E ĐẠT** |
| `queued` / `pending` | Đang xử lý, chờ 1–2 phút |
| `waiting_signer` | Mục 3.7 chưa xong, hoặc chain-worker không chạy |
| `failed` / `blocked` | Lỗi, xem `fail_reason` và `docker compose logs chain-worker` |
| `legacy_domain` | Record ký cho contract cũ, đúng thiết kế, không gửi lên chain |

**Bằng chứng cuối:** Etherscan › Events có `IncidentLogged` với tx hash trùng cột
`tx_hash`. App (hoặc dApp web3 khi đã có) hiển thị incident có trạng thái chain `confirmed`.

---

## Báo cáo kết quả cho team

Gửi lại các thông tin sau. **Không** gửi nội dung `.env`:

| Mục | Kết quả |
|---|---|
| Mức 1 (`chain-e2e.test.js`) | `pass __ / fail __` |
| Mức 2 (health `ready`, `incident-mqtt.e2e.test.js`) | ok / lỗi |
| `device_id` + signer address | |
| Tx `DeviceRegistered` | `0x…` |
| Tx `IncidentLogged` | `0x…` |
| `blockchain_outbox.status` | |
| Log lỗi (nếu có) | |

## Sau khi test xong

```powershell
cd server
docker compose stop chain-worker
docker rm -f sa-quicktunnel
docker compose down
```

- Báo người giao `.env` là worker của bạn **đã dừng**, để họ chạy lại worker của họ.
- Flash lại bản production (mục 3.5) để bỏ chế độ replay.
- Xóa `server\.env` khỏi máy, hoặc trả lại theo thỏa thuận.

## Xử lý sự cố

| Hiện tượng | Cách sửa |
|---|---|
| EMQX kẹt `Starting`, lỗi `can't bind on the specified endpoint` | Sửa `MQTT_LAN_BIND_IP` theo `ipconfig`, rồi `docker compose up -d` |
| API log `EMQX API … 401` | Làm lại mục 2.1 (bootstrap), rồi `docker compose up -d --force-recreate emqx api` |
| nginx `Exited (1)`, `cannot load certificate` | Làm lại mục 2.1 (cert), rồi `docker compose up -d nginx` |
| API thoát ngay, báo lỗi domain | RPC hoặc `.env` bị sửa nhầm. Lấy lại `.env` gốc, chỉ sửa 3 biến cho phép |
| chain-worker exit code 2 | Gửi log cho người giao `.env` (mất role hoặc sai domain) |
| Tx lỗi `nonce too low` / `replacement underpriced` | Có worker khác đang chạy cùng ví. Xem lại quy tắc 2 |
| Outbox `blocked` | Hết ETH hoặc RPC lỗi lâu. Nạp ETH rồi chạy `docker exec sa-chain-worker node scripts/chain-ops.js requeue-outbox --all-blocked` (xem [`CHAIN_WORKER_RUNBOOK.md`](CHAIN_WORKER_RUNBOOK.md)) |
| Indexer lỗi range `eth_getLogs` | Thêm `CHAIN_LOG_BATCH_BLOCKS=500` vào `.env` (ngoại lệ được phép), rồi restart worker |
| Board không kết nối MQTT | URL tunnel đã đổi, hoặc sai `broker_uri`. Build lại app và provision lại |
| `idf.py` không nhận | Mở "ESP-IDF 5.4 PowerShell" |
| Hardhat `EADDRINUSE 8545` | Đã có node chạy sẵn, dùng luôn node đó |
