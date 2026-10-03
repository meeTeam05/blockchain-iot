# Runbook demo báo cáo (Task 1 đến Task 8)

Nhánh: `feature/task8-incentives-dapp` (chứa toàn bộ Task 1 đến 8).
Thư mục gốc repo: `/home/nhat/workspace/prjs/blockchain-iot`. Mọi lệnh chạy từ thư mục gốc trừ khi có dòng `cd`.

Runbook vận hành server: [`ops/_RUN_BOOK.md`](ops/_RUN_BOOK.md). Runbook chain-worker: [`ops/CHAIN_WORKER_RUNBOOK.md`](ops/CHAIN_WORKER_RUNBOOK.md).

## Cách đọc file này

Mỗi bước có đúng 3 phần:

- **Lệnh:** chép và chạy nguyên văn.
- **Đúng khi:** những chuỗi ký tự hoặc trạng thái phải thấy. Thiếu một dòng là sai.
- **Sai thì:** việc làm ngay.

Cách đánh dấu kết quả:
- `(đã chạy)`: kết quả này đã được thấy thật trên máy này ngày 2026-10-03.
- `(theo tài liệu)`: lấy từ tài liệu hoặc code của dự án, chưa chạy lại. Nên chạy thử một lần trước ngày demo.

Ba tầng demo:

| Tầng | Nội dung | Cần | Rủi ro |
|---|---|---|---|
| 1 | Offline trên laptop: firmware, test contract, test backend, kịch bản Task 8 qua trình duyệt | Laptop | Thấp |
| 2 | Live: board thật, server Docker, Sepolia, app điện thoại, MetaMask | Kit, điện thoại, mạng, `server/.env` Sepolia, ví owner | Cao |
| 3 | Dự phòng: hardhat local, Etherscan, video | Laptop | Thấp |

Quy tắc: chạy tầng 1, rồi tầng 2. Nếu một bước tầng 2 quá 3 phút không ra kết quả đúng, chuyển sang Phần C, không sửa lỗi trước hội đồng.

---

## Run sheet (một màn hình)

| # | Tầng | Việc | Lệnh chính | Đúng khi |
|---|---|---|---|---|
| B1 | 1 | Cấu hình firmware | `idf.py ... menuconfig` | Thấy mục `Blockchain incidents` = Sepolia |
| B2 | 1 | Build firmware | `idf.py ... build` | `Project build complete` |
| B3 | 1 | Test contract | `cd blockchain && npm test` | `84 passing` |
| B4 | 1 | Domain EIP-712 khớp | `node spec/incident/gen/gen-all.mjs --check` | `generated incident domain files are up to date` |
| B5 | 1 | Test backend | `IDF_PATH=... npm test` | `ℹ fail 0` |
| B6 | 1 | Task 8 qua trình duyệt | `npm run test:incentives-e2e` | `1 passed` |
| B7 | 2 | Board tạo incident | `idf.py -B build-replay ... app-flash monitor` | `accepted:true` |
| B8 | 2 | Incident lên Sepolia | truy vấn `blockchain_outbox` | `confirmed` + `tx_hash` |
| B9 | 2 | App điện thoại báo incident | mở app | Có thông báo, bấm "Xem trên chain" |
| B10 | 2 | dApp đăng nhập, thấy thiết bị | `https://minhnhat05.xyz/dapp/` | Thiết bị `active`, nhãn "Bạn" |
| B11 | 2 | Kịch bản A: verify, ack, resolve | dApp + MetaMask | 4 dòng pass, rồi 3 event trong Lịch sử |
| B12 | 2 | Task 8 live: stake, thưởng | dApp `/wallet` | Số dư và nhãn `+5` |

---

# Phần A. Chuẩn bị (làm trước ngày demo, và sáng ngày demo)

Đánh dấu vào ô khi xong.

- [ ] A1 Công cụ
- [ ] A2 Cài app lên điện thoại
- [ ] A3 Lấy `server/.env` Sepolia
- [ ] A4 Kiểm tra `server/.env` và tạo ví keeper
- [ ] A5 Build dApp cho Sepolia
- [ ] A6 Build sẵn 2 bản firmware
- [ ] A7 Provision board bằng app
- [ ] A8 Cấp ASAFE cho ví owner
- [ ] A8b (tùy chọn) Nới `maxRelayDelay`
- [ ] A9 Quay video dự phòng
- [ ] A10 Sáng ngày demo: dựng stack và kiểm tra

## A1. Công cụ trên laptop

**Lệnh**
```bash
. /home/nhat/workspace/esp-idf/export.sh && idf.py --version
adb version | head -1
docker ps > /dev/null && echo DOCKER_OK
node --version
git branch --show-current
```

**Đúng khi `(đã chạy)`**
- Dòng đầu là `ESP-IDF v5.4.2`.
- Dòng tiếp là `Android Debug Bridge version 1.0.41` (hoặc phiên bản khác bắt đầu bằng `Android Debug Bridge`).
- Có dòng `DOCKER_OK`.
- Node in một phiên bản (máy này: `v24.21.0`).
- Dòng cuối là `feature/task8-incentives-dapp`.

**Sai thì**
- `docker ps` lỗi: `make host-docker-start`.
- Không có `idf.py`: kiểm tra file `/home/nhat/workspace/esp-idf/export.sh` tồn tại.

Ghi chú về Makefile:
- `make firmware-*` tự tìm `export.sh` ở `~/workspace/esp-idf`, `~/.espressif/v5.4.2/esp-idf` hoặc `~/esp/esp-idf`; đặt `IDF_EXPORT=...` để ép đường dẫn khác. Các target này build với cấu hình mặc định, không nạp profile `sdkconfig.incident`, nên demo vẫn dùng lệnh `idf.py` trực tiếp như dưới đây.
- `make app-*` giờ dùng Expo: `app-install`, `app-lint`, `app-test`, `app-run`, `app-build-release`.

## A2. Cài app lên điện thoại (chỉ `app/`, Expo)

`app/` mặc định gọi `https://minhnhat05.xyz/api` và `wss://minhnhat05.xyz/mqtt` (`app/src/config/env.ts`), nên không cần biến môi trường khi build. Android package: `xyz.minhnhat05.smartair.test`.

Trên điện thoại: bật Developer options, bật USB debugging, cắm cáp USB có dây data, chấp nhận hộp thoại "Allow USB debugging".

**Lệnh (kiểm tra máy được nhận)**
```bash
adb devices
```
**Đúng khi (theo tài liệu):** có một dòng dạng `<mã máy>    device`.
**Sai thì:** `unauthorized` thì chấp nhận lại hộp thoại trên điện thoại. Danh sách rỗng thì đổi cáp.

**Lệnh (build bản release và cài, cách chính)**
```bash
cd app
npm install
npx expo run:android --variant release
```
**Đúng khi (theo tài liệu):**
- Lệnh kết thúc không lỗi.
- App "Smart Air" tự mở trên điện thoại.
- Thư mục `app/android` được sinh ra (đã nằm trong `.gitignore`).

Lần đầu build mất vài phút. Bản release đóng gói sẵn JS, không cần Metro khi demo.

**Cách dự phòng (Gradle, chưa chạy thử)**
```bash
cd app && npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```
**Đúng khi:** lệnh cuối in `Success`.

Cần đổi server (ví dụ quick tunnel `trycloudflare.com`): đặt `EXPO_PUBLIC_API_BASE_URL=https://<tên>.trycloudflare.com/api` và `EXPO_PUBLIC_MQTT_BROKER_URI=wss://<tên>.trycloudflare.com/mqtt` trước lệnh build. Giá trị được nhúng lúc build, đổi URL là phải build lại.

## A3. Lấy `server/.env` Sepolia (điều kiện bắt buộc của tầng 2)

Máy này (2026-10-03) đang có `server/.env` ở chế độ hardhat local: `INCIDENT_DEPLOYMENT=localhost`, `CHAIN_RPC_URL=http://host.docker.internal:8545`, và hai khóa ví là tài khoản mặc định của hardhat, không phải ví Sepolia thật. Tầng 2 cần:

1. `server/.env` Sepolia từ người giữ file (theo `docs/tasks/Task5_8_plan.md` là Viet Ho). Xem phần "3 quy tắc" trong [`ops/E2E_GUIDE_SERVER_ENV_HOLDER.md`](ops/E2E_GUIDE_SERVER_ENV_HOLDER.md).
2. Người giữ `.env` xác nhận đã **dừng chain-worker của họ**. Chỉ một worker được chạy với cùng ví relayer, nếu không tranh nonce.

**Lệnh (sao lưu `.env` hiện tại trước khi thay)**
```bash
cp server/.env server/.env.hardhat-local
ls -l server/.env.hardhat-local
```
**Đúng khi:** `ls` in ra một file. `server/.env.hardhat-local` chưa nằm trong `.gitignore`, **không** `git add` file này.

Thiếu 1 hoặc 2: bỏ phần board của tầng 2, dùng Phần C.

## A4. Kiểm tra `server/.env` (sau khi đã thay bằng bản Sepolia)

**Lệnh 1: các biến bắt buộc phải có (chỉ in tên, không in giá trị)**
```bash
grep -E '^(INCIDENT_DEPLOYMENT|CHAIN_RPC_URL|RELAYER_PRIVATE_KEY|DEVICE_MANAGER_PRIVATE_KEY|EMQX_API_KEY|JWT_SECRET|CLOUDFLARE_TUNNEL_TOKEN)=.+' server/.env | cut -d= -f1
```
**Đúng khi:** in đủ 7 dòng, thứ tự theo file `.env` (không cố định): `INCIDENT_DEPLOYMENT`, `CHAIN_RPC_URL`, `RELAYER_PRIVATE_KEY`, `DEVICE_MANAGER_PRIVATE_KEY`, `EMQX_API_KEY`, `JWT_SECRET`, `CLOUDFLARE_TUNNEL_TOKEN`. Với `.env` hardhat hiện tại trên máy này cũng ra đủ 7 dòng (`(đã chạy)`), nên lệnh này chỉ kiểm tra biến có giá trị, không phân biệt local hay Sepolia. Phân biệt bằng lệnh 2 và lệnh 4.
**Sai thì:** thiếu dòng nào thì báo người giữ `.env`.

**Lệnh 2: hai khóa ví ứng với địa chỉ nào (chỉ in địa chỉ)**
```bash
node -e '
const {ethers}=require("./blockchain/node_modules/ethers");const fs=require("fs");
const env=Object.fromEntries(fs.readFileSync("server/.env","utf8").split("\n").filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
for(const k of ["RELAYER_PRIVATE_KEY","DEVICE_MANAGER_PRIVATE_KEY"])console.log(k,"->",new ethers.Wallet(env[k]).address);'
```
**Đúng khi:**
```text
RELAYER_PRIVATE_KEY -> 0xe9426f8AbFf21ddb99a4Ca383c2b71D9AF95197d
DEVICE_MANAGER_PRIVATE_KEY -> 0x106ce92E3664AeD1330c183aFdF2D5Ff7618D29A
```
**Sai thì:** nếu ra `0x70997970...` và `0x3C44Cd...` (đã thấy trên máy này, `(đã chạy)`) thì đó là khóa hardhat, quay lại A3.

**Lệnh 3: các giá trị cấu hình**
```bash
grep -E '^(INCIDENT_DEPLOYMENT|INCENTIVES_ENABLED|KEEPER_ENABLED|CORS_ORIGINS|OTA_PUBLIC_BASE_URL)=' server/.env
```
**Đúng khi:** có đủ các dòng sau (sửa bằng editor nếu khác):
```text
INCIDENT_DEPLOYMENT=sepolia
INCENTIVES_ENABLED=true
KEEPER_ENABLED=true
CORS_ORIGINS=...https://minhnhat05.xyz...
OTA_PUBLIC_BASE_URL=https://minhnhat05.xyz
```
`KEEPER_ENABLED=true` cần `KEEPER_PRIVATE_KEY` (lệnh 5): keeper ghi nhận thưởng R1 và R2 thay owner và phạt P1 khi quá hạn. Nó không bao giờ gọi `slashLateRelay` (P2 để keeper bên ngoài hoặc bấm tay ở `/keeper`). `CORS_ORIGINS` có thể liệt kê nhiều origin, ngăn cách bằng dấu phẩy, nhưng phải chứa `https://minhnhat05.xyz`. Trên máy này hiện chỉ có `localhost`.

**Lệnh 4: RPC không còn trỏ về hardhat local**
```bash
grep -c 'host.docker.internal' server/.env
```
**Đúng khi:** in `0`.

**Lệnh 5: tạo ví keeper (chỉ khi `KEEPER_PRIVATE_KEY` còn trống)**

Keeper phải là ví riêng, khác relayer, device manager và operator. Nếu trùng, chain-worker thoát với exit code 2 (`assertKeeperWallet` trong `server/api/src/chain/incentives.js`). Lệnh dưới sinh khóa, ghi vào `server/.env` và chỉ in địa chỉ. Không ghi đè khóa đã có.
```bash
node -e '
const {ethers}=require("./blockchain/node_modules/ethers");const fs=require("fs");
const f="server/.env";let t=fs.readFileSync(f,"utf8");
if(/^KEEPER_PRIVATE_KEY=.+/m.test(t)){console.log("KEEPER_PRIVATE_KEY da co, khong ghi de");process.exit(0)}
const w=ethers.Wallet.createRandom();
t=/^KEEPER_PRIVATE_KEY=.*$/m.test(t)?t.replace(/^KEEPER_PRIVATE_KEY=.*$/m,"KEEPER_PRIVATE_KEY="+w.privateKey):t.replace(/\n?$/,"\nKEEPER_PRIVATE_KEY="+w.privateKey+"\n");
fs.writeFileSync(f,t);console.log("keeper address:",w.address);'
```
**Đúng khi `(đã chạy trên bản sao .env)`:** in một dòng `keeper address: 0x...` (42 ký tự). Chạy lần hai in `KEEPER_PRIVATE_KEY da co, khong ghi de`. Ghi lại địa chỉ này.
**Sai thì:** không tìm thấy `ethers` thì chạy `cd blockchain && npm ci` rồi thử lại.

**Lệnh 6: nạp ETH cho ví keeper và kiểm tra số dư**

Gửi khoảng 0.01 Sepolia ETH tới địa chỉ keeper (faucet hoặc từ ví khác của bạn; không dùng ví relayer hay manager).
```bash
KEEPER=0x...   # địa chỉ in ở lệnh 5
curl -s -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$KEEPER\",\"latest\"]}" https://ethereum-sepolia-rpc.publicnode.com
```
**Đúng khi (theo tài liệu):** `result` lớn hơn `0x2386f26fc10000` (0.01 ETH = 10^16 wei). Worker cảnh báo `keeper wallet is low on ETH` khi dưới 0.002 ETH và thoát nếu số dư bằng 0.

## A5. Build dApp cho Sepolia

`web3/.env.local` đang là `VITE_NETWORK=localhost`. Biến đặt ở dòng lệnh có ưu tiên cao hơn file `.env`, nên không cần sửa file.

**Lệnh**
```bash
cd web3
VITE_NETWORK=sepolia \
VITE_API_BASE_URL=https://minhnhat05.xyz/api \
VITE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
npm run build
grep -l 'minhnhat05.xyz/api' dist/assets/*.js
```
**Đúng khi:**
- Có dòng `built in ...` (đã chạy, `(đã chạy)` bằng `vite build` ra thư mục tạm).
- `grep -l` in ra ít nhất một file `dist/assets/index-*.js`.

nginx mount `web3/dist` chỉ đọc tại `/dapp/`, file mới có hiệu lực ngay, không cần restart. `VITE_RPC_URL` bị nhúng vào bundle công khai: không dùng RPC có API key riêng.

## A6. Build sẵn 2 bản firmware (làm sớm, lần đầu mất vài phút)

**Lệnh**
```bash
cd firmware
. /home/nhat/workspace/esp-idf/export.sh
idf.py -B build-incident -D SDKCONFIG=sdkconfig.incident.generated \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident" build
idf.py -B build-replay -D SDKCONFIG=sdkconfig.replay.generated \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident;sdkconfig.incident.network-replay" build
```
**Đúng khi `(đã chạy)`:**
- Mỗi lệnh kết thúc bằng `Project build complete`.
- Bản `build-incident`: `smart-air.bin binary size 0x1684d0 bytes`, `(30%) free`.
- Bản `build-replay`: `smart-air.bin binary size 0x16a670 bytes`, `(29%) free`.

**Sai thì:** lỗi component hay thiếu gói: kiểm tra mạng (build tải component lần đầu), chạy lại.

## A7. Provision board bằng app (làm trước ngày demo, không làm trên sân khấu)

1. Bật hotspot điện thoại (hoặc đúng mạng sẽ dùng khi demo). Wi-Fi lưu trong NVS, đổi mạng là phải provision lại.
2. Trong app: đăng ký tài khoản, thêm thiết bị qua BLE (tên `SMART_AIR_xxxxxx`), nhập Wi-Fi.
3. Ghi lại email và mật khẩu của tài khoản này: dApp đăng nhập bằng đúng tài khoản đó (B10).

**Đúng khi (theo tài liệu):** log serial của board báo đã kết nối MQTT, và thiết bị hiện trong app.

Không bao giờ chạy `idf.py erase-flash`: lệnh này xóa signer, sequence và queue incident.

## A8. Cấp ASAFE cho ví owner (cần cho B12)

Ví owner `0x4aC8fe56c966496a12fCDEc5a1B01c21a97CF30B` có **0 ASAFE** và 0.05 ETH (`(đã chạy)`, 2026-10-03). Treasury (admin `0x7Ee5...1a3F`) đang giữ 949000 ASAFE. Cần file `blockchain/.env` với `DEPLOYER_PRIVATE_KEY` của admin; máy này chưa có file đó.

**Lệnh (chưa chạy thử)**
```bash
cd blockchain
npx hardhat console --network sepolia
```
Trong console:
```js
const t = await ethers.getContractAt("AirSafeToken", "0xD01324896e7cCc099DB95212a54b5473a3B2DE34")
await (await t.transfer("0x4aC8fe56c966496a12fCDEc5a1B01c21a97CF30B", ethers.parseEther("200"))).wait(2)
ethers.formatEther(await t.balanceOf("0x4aC8fe56c966496a12fCDEc5a1B01c21a97CF30B"))
```
**Đúng khi (theo tài liệu):** lệnh cuối in `'200.0'`. 200 ASAFE đủ cho một lần stake 100 ASAFE (`ownerBond`).

Kiểm tra lại không cần khóa (chạy được ở bất kỳ máy nào, thay `0x...` bằng ví owner):
```bash
curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xD01324896e7cCc099DB95212a54b5473a3B2DE34","data":"0x70a082310000000000000000000000004aC8fe56c966496a12fCDEc5a1B01c21a97CF30B"},"latest"]}' https://ethereum-sepolia-rpc.publicnode.com
```
**Đúng khi `(đã chạy)` với hai trường hợp:** trước khi cấp, `result` là `0x` rồi 64 chữ số `0` (số dư 0, đúng trạng thái 2026-10-03). Sau khi cấp đúng 200 ASAFE, `result` kết thúc bằng `ad78ebc5ac6200000` (200 x 10^18 viết hex, tính bằng `node`). Ví treasury cho kết quả kết thúc bằng `c8f564a12e8247200000` (949000 ASAFE), dùng để đối chiếu định dạng.

## A8b. (Tùy chọn) Nới `maxRelayDelay` trên Sepolia

Luật P2 phạt operator khi `loggedAt - observedAt` vượt `maxRelayDelay`, nên một thiết bị offline lâu hơn ngưỡng làm operator bị phạt dù relayer ghi ngay (xem "Giới hạn đã biết" trong `tasks/Token_incentive_task.md`). Contract không đổi được cách đo, nhưng admin nới được ngưỡng bằng `setParams`, không cần deploy lại.

**Lệnh 1: đọc giá trị hiện tại (không cần khóa)**
```bash
cd blockchain && node -e '
const {ethers}=require("ethers");
(async()=>{const p=new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com",11155111,{staticNetwork:true});
const abi=require("./abi/SafetyIncentives.json");
const c=new ethers.Contract("0x4078c3a86708B4C4B3aD61aB5A282e0E6A9FAA04",abi.abi||abi,p);
console.log("maxRelayDelay =",(await c.params()).maxRelayDelay.toString());})()'
```
**Đúng khi `(đã chạy)`:** in `maxRelayDelay = 900` (15 phút, trạng thái 2026-10-03).

**Lệnh 2: đặt 3600 giây (1 giờ), cần `blockchain/.env` với `DEPLOYER_PRIVATE_KEY` của admin**
```bash
cd blockchain
npx hardhat console --network sepolia
```
Trong console:
```js
const inc = await ethers.getContractAt("SafetyIncentives", "0x4078c3a86708B4C4B3aD61aB5A282e0E6A9FAA04")
const p = (await inc.params()).toObject()
await (await inc.setParams({ ...p, maxRelayDelay: 3600n })).wait(2)
```
Đoạn này giữ nguyên mọi tham số khác và chỉ đổi `maxRelayDelay`. Đã kiểm tra trên hardhat cục bộ `(đã chạy)`: các tham số khác không đổi và có thêm một event `ParamsUpdated`. Chưa chạy trên Sepolia (cần khóa admin).
**Đúng khi (theo tài liệu):** chạy lại Lệnh 1 in `maxRelayDelay = 3600`; trang `/params` của dApp hiện giá trị mới; API `GET /api/incentives/params` có `max_relay_delay` là `"3600"` sau khi worker làm mới snapshot (tối đa `INCENTIVES_STATE_REFRESH_MS`, mặc định 60 giây).

Đánh đổi: relay chậm dưới 1 giờ không còn bị phạt. Nếu muốn trình bày P2 bằng số liệu mặc định (15 phút) thì dùng B6 (kịch bản tự động chạy trên hardhat riêng, không bị ảnh hưởng bởi tham số trên Sepolia). Khôi phục: chạy lại Lệnh 2 với `maxRelayDelay: 900n`.

## A9. Quay video dự phòng (cho Phần C)

Quay sẵn, mỗi đoạn dưới 1 phút, lưu ngoài git:
1. Boot board và log replay đến khi có `accepted:true`.
2. dApp trang incident đến khi 4 dòng verify pass.
3. Ack và resolve bằng MetaMask.
4. `/wallet` stake và `+5`.

## A10. Sáng ngày demo: dựng stack và kiểm tra (làm trước giờ báo cáo khoảng 30 phút)

**Lệnh 1: dựng server**
```bash
make server-env-check
make server-up
cd server && docker compose --profile chain up -d chain-worker && cd ..
make server-ps
```
**Đúng khi:**
- `make server-env-check` không in dòng `Missing`.
- `make server-ps` liệt kê `sa-postgres`, `sa-redis`, `sa-emqx`, `sa-api`, `sa-nginx`, `sa-cloudflared`, `sa-chain-worker` đều ở trạng thái `Up`, và 5 service đầu có `(healthy)` (theo tài liệu).

`make server-up-build` chỉ cần khi code API đổi (build lại image `smart-air-api:local`, cần mạng).

**Lệnh 2: server và tunnel**
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://minhnhat05.xyz/api/health/live
curl -s https://minhnhat05.xyz/api/health/ready
```
**Đúng khi:**
- Lệnh đầu in `200`.
- Lệnh sau in JSON có `"status":"ok"` và `"checks"` gồm `postgres`, `redis`, `emqx`, `mqtt`, `realtime` đều `ok`.

**Sai thì:** `530` nghĩa là tunnel chưa lên (đã thấy khi stack tắt, `(đã chạy)`): `docker logs sa-cloudflared --tail 20`. `503` nghĩa là một dịch vụ `degraded`, xem `checks`.

**Lệnh 3: chain-worker**
```bash
docker logs sa-chain-worker --tail 30
```
**Đúng khi:**
- Có `"msg":"chain worker started"`.
- Cùng log có `"contract":"0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A"` và `"relayer":"0xe9426f8AbFf21ddb99a4Ca383c2b71D9AF95197d"`.
- Có `"msg":"incentives enabled"` kèm `"keeper":"0x..."` bằng địa chỉ ví keeper ở A4 lệnh 5 (`server/api/src/worker.js`). Nếu `"keeper":null` thì `KEEPER_ENABLED` chưa là `true`.
- Không có `"level":50`.

**Sai thì:** worker thoát với exit code 2 là lỗi nghiêm trọng (mất role, domain hoặc RPC sai, ví keeper trùng ví khác hoặc không có ETH). Xem `ops/CHAIN_WORKER_RUNBOOK.md`, chuyển sang Phần C.

**Lệnh 4: sức khỏe chain**
```bash
make chain-status | head -5
curl -s https://minhnhat05.xyz/api/health/chain
```
**Đúng khi:** cả hai có `"status": "ok"` (lệnh sau là JSON một dòng có `"status":"ok"`). Không có phần tử trong `reasons`.

**Lệnh 5: kit có trong DB và trên contract**
```bash
docker exec sa-postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT id FROM devices;"'
docker exec sa-api node scripts/device-signer.js show dc:b4:d9:13:ed:8c
```
**Đúng khi:**
- Bảng `devices` có dòng `dc:b4:d9:13:ed:8c`.
- JSON của `show` có `"active": true` trong `chain` và `"contract_address"` bằng `0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A`.

**Sai thì:** kit chưa có trong DB thì provision lại bằng app (A7). Khi đó contract đã đăng ký sẵn thiết bị này nên bước `register` sẽ báo `DeviceAlreadyActive` hoặc `SignerAlreadyUsed`: dùng lệnh `sync-chain` theo ghi chú đầu file `server/api/scripts/device-signer.js` (chưa chạy thử) và hỏi người giữ `.env`. Không chạy lại bước ghi signer cho board đã có signer.

**Lệnh 6: MetaMask**

Mở MetaMask trên trình duyệt desktop, chọn mạng **Sepolia**. Nếu MetaMask còn mạng tùy chỉnh trùng chain ID `11155111` trỏ về `127.0.0.1:8545`, xóa hoặc đổi tên nó.

**Đúng khi:** dApp không hiện banner đỏ wrong RPC hoặc domain (xem B10). Không bỏ qua banner đó.

---

# Phần B. Kịch bản demo (theo thứ tự trình bày)

## Tầng 1. Offline trên laptop

### B1. Firmware: cấu hình bằng menuconfig

**Lệnh**
```bash
cd firmware
. /home/nhat/workspace/esp-idf/export.sh
idf.py -B build-incident -D SDKCONFIG=sdkconfig.incident.generated \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident" menuconfig
```
`make firmware-menuconfig` không nạp profile incident, nên không dùng cho demo.

**Đúng khi:** mở được giao diện menuconfig, và đi theo các đường dưới đây thấy đúng giá trị. Thoát bằng `Q`, hỏi lưu thì chọn `N`.

| Chỉ cho hội đồng | Đường dẫn trong menuconfig | Giá trị đúng |
|---|---|---|
| Cảnh báo sớm CO/NO2 | `Smart Air Configuration` > `Peripheral Enable/Disable` > `Enable on-device CO/NO2 early warning` | `[*]` |
| Hàng đợi incident ký EIP-712 | `Smart Air Configuration` > `Peripheral Enable/Disable` > `Enable Blockchain Incident Schema v2 queue` | `[*]` |
| Sức chứa hàng đợi | `Smart Air Configuration` > `Blockchain incidents` > `Persistent incident queue capacity` | `4` |
| Môi trường contract | `Smart Air Configuration` > `Blockchain incidents` > `AirSafetyLog deployment (EIP-712 domain)` | `Sepolia` |
| Replay dữ liệu giả (chỉ bản test) | `Smart Air Configuration` > `AI (on-device inference)` > `Replay simulated sensor data into the AI` | `[ ]` ở bản production |
| Mã hóa NVS | bấm `/`, gõ `NVS_ENCRYPTION` | `[*]` |

Điểm nói: domain EIP-712 lấy từ `spec/incident/deployments/sepolia.json` qua `incident_domain.h`, không gõ tay địa chỉ.

**Sai thì:** thiếu mục `Blockchain incidents` nghĩa là chưa bật `Enable Blockchain Incident Schema v2 queue` (mục này phụ thuộc `Enable on-device CO/NO2 early warning`).

### B2. Firmware: build

**Lệnh**
```bash
cd firmware
. /home/nhat/workspace/esp-idf/export.sh
idf.py -B build-incident -D SDKCONFIG=sdkconfig.incident.generated \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.incident" build
grep -E "^CONFIG_(IDF_TARGET|SA_INCIDENT_ENV_SEPOLIA|NVS_ENCRYPTION)=" sdkconfig.incident.generated
```
**Đúng khi `(đã chạy)`:**
- Có dòng `Project build complete`.
- `grep` in đúng 3 dòng:
  ```text
  CONFIG_IDF_TARGET="esp32s3"
  CONFIG_SA_INCIDENT_ENV_SEPOLIA=y
  CONFIG_NVS_ENCRYPTION=y
  ```
- `smart-air.bin binary size 0x1684d0 bytes`, partition app còn trống 30%.

Đã build ở A6 thì lần này build nhanh hơn (build tăng dần).

### B3. Contract: test Hardhat

**Lệnh**
```bash
cd blockchain && npm test
```
**Đúng khi `(đã chạy)`:** có dòng `84 passing` và không có dòng `failing`. Gồm test vector, tamper, signer, replay, role, incentives và kịch bản một ngày.

Node 24 có thể in `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` lúc thoát: bỏ qua (xem `blockchain/README.md`).

### B4. Domain EIP-712 khớp giữa firmware, backend và dApp

**Lệnh**
```bash
node spec/incident/gen/gen-all.mjs --check
```
**Đúng khi `(đã chạy)`:** in `generated incident domain files are up to date`.
**Sai thì:** chạy `make incident-gen` rồi kiểm tra `git diff`.

### B5. Backend: test API

**Lệnh**
```bash
cd server/api
IDF_PATH=/home/nhat/workspace/esp-idf npm test
```
**Đúng khi `(đã chạy)`:** cuối output có `ℹ tests 239`, `ℹ pass 235`, `ℹ fail 0`, `ℹ skipped 4`.
**Sai thì:** thiếu `IDF_PATH` thì test `firmware-wire-contract.test.js` fail vì tìm `~/esp/esp-idf/components/json/cJSON`. Đây là lỗi môi trường, không phải lỗi code.

### B6. Task 8: toàn bộ luật thưởng/phạt qua trình duyệt thật

Gate độc lập, không cần Sepolia, EMQX hay board. Harness tự dựng Hardhat (`18545`), API/indexer/relayer Task 7 trên PGlite (`3006`) và Vite (`5176`).

**Lệnh**
```bash
cd web3
npm run test:incentives-e2e
```
**Đúng khi `(đã chạy)`:**
- Có dòng `✓  1 e2e/incentives.spec.ts:36:1 › one day through the real UI: approve/stake, R1/R2, P1, manual P2, daily cap and cooldown`.
- Cuối output có `1 passed` (khoảng 30 giây).

Kịch bản đi qua UI các bước: approve và stake, verify evidence, ack/resolve (thưởng R1 và R2), phạt P1 (owner bỏ qua ack), phạt P2 bấm tay (operator relay trễ), trần thưởng theo ngày, quỹ thưởng không đủ, cooldown và withdraw. Các luật và tham số: [`tasks/Token_incentive_task.md`](tasks/Token_incentive_task.md).

Muốn hội đồng nhìn thấy trình duyệt: `npm run test:incentives-e2e -- --headed` (chưa chạy thử với `--headed`).

**Sai thì:** `browserType.launch: Executable doesn't exist` thì chạy `npx playwright install chromium` một lần rồi chạy lại.

## Tầng 2. Live (Sepolia + board thật)

Điều kiện: A3 đến A10 đã xong và đúng.

### B7. Board tạo incident bằng bản replay

Board đã có signer (không cần bước eFuse hay signer-provision). Chỉ flash phần app, giữ NVS. Flash sớm hơn lúc lên sân khấu khoảng 5 phút.

**Lệnh**
```bash
cd firmware
. /home/nhat/workspace/esp-idf/export.sh
ls /dev/ttyACM* /dev/ttyUSB*
idf.py -B build-replay -p /dev/ttyACM0 app-flash monitor
```
Thay `/dev/ttyACM0` bằng cổng thấy ở lệnh `ls`. Thoát monitor bằng `Ctrl+]`. Lỗi `Permission denied` trên cổng serial thì thêm user vào nhóm `dialout`, đăng nhập lại.

**Đúng khi (theo tài liệu `E2E_GUIDE_SERVER_ENV_HOLDER.md` mục 3.5 và 3.8):**
- Log boot có dòng:
  ```text
  incident domain sepolia contract 0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A separator 0x34632810...
  ```
- Còi kêu (replay chạy x60, kịch bản `co_event` dài khoảng 72 giây theo chú thích Kconfig).
- Log báo incident được ký và publish, và nhận ACK `accepted:true`.

**Sai thì:** lỗi domain, hoặc log báo không ký: dừng, chuyển Phần C. Log có `incident skipped: signer awaiting signer_activate sequence floor` là đúng thiết kế khi signer chưa kích hoạt xong, nghĩa là A10 lệnh 5 chưa đạt.

### B8. Incident lên Sepolia

Chờ 1 đến 2 phút (3 confirmations). Trong lúc chờ, kể kiến trúc.

**Lệnh 1**
```bash
docker exec sa-postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT status, tx_hash, fail_reason FROM blockchain_outbox ORDER BY 1;"'
```
**Đúng khi (theo tài liệu):** có dòng mới nhất với `status` là `confirmed` và cột `tx_hash` có giá trị `0x...`.

| `status` | Ý nghĩa và việc làm |
|---|---|
| `confirmed` + `tx_hash` | Đạt |
| `queued`, `pending` | Chờ thêm 1 đến 2 phút |
| `waiting_signer` | Chưa xong A10 lệnh 5, hoặc `sa-chain-worker` không chạy |
| `failed`, `blocked` | Xem cột `fail_reason` và `docker logs sa-chain-worker` |
| `legacy_domain` | Ký cho contract cũ, đúng thiết kế, không gửi lên chain |

**Lệnh 2: kiểm tra giao dịch trên Sepolia bằng RPC công khai** (thay `0x...` bằng `tx_hash` ở trên)
```bash
TX=0x...
curl -s -X POST -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$TX\"]}" \
  https://ethereum-sepolia-rpc.publicnode.com | grep -oE '"(status|to)":"0x[0-9a-fA-F]+"'
```
**Đúng khi:** in đúng 2 dòng:
```text
"status":"0x1"
"to":"0x45cf175ffd4b1ad77e87389d1e92945f9bc88d3a"
```
Mẫu lệnh này đã chạy với tx deploy AirSafeToken (`(đã chạy)`: ra `"status":"0x1"`).

**Lệnh 3: Etherscan.** Mở `https://sepolia.etherscan.io/tx/<tx_hash>`.
**Đúng khi:** `Status: Success`, và tab Events của `https://sepolia.etherscan.io/address/0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A#events` có `IncidentLogged` mới nhất khớp `tx_hash`.

### B9. App điện thoại: nhận cảnh báo

1. Mở app "Smart Air" trên điện thoại (đã cài ở A2), đăng nhập tài khoản đã provision board.
2. Vào thông báo của thiết bị.

**Đúng khi (theo tài liệu):**
- Có thông báo incident mức warning hoặc danger.
- Chi tiết incident hiện trạng thái chain (`IncidentChainStatus`).
- Bấm "Xem trên chain" mở link `https://metamask.app.link/dapp/minhnhat05.xyz/dapp/d/<device_id>/i/<incident_id>` (`app/src/lib/dappLink.ts`). Cần MetaMask Mobile trên điện thoại (chưa chạy thử trên máy thật).

**Sai thì:** không thấy thông báo thì kiểm tra B8 lệnh 1; để trình chiếu, mở thẳng route incident trên laptop ở B10.

### B10. dApp: đăng nhập, thấy thiết bị

Mở `https://minhnhat05.xyz/dapp/`. Đăng nhập bằng tài khoản app (A7), kết nối MetaMask bằng ví owner `0x4aC8...CF30B`.

**Đúng khi (theo tài liệu, mốc M1 của Task 5):**
- Danh sách thiết bị có `dc:b4:d9:13:ed:8c`, trạng thái `active`.
- Có nhãn "Bạn" vì owner của thiết bị khớp ví đang kết nối.
- Không có banner đỏ.

**Sai thì:** banner wrong RPC hoặc domain: làm A10 lệnh 6, không bỏ qua banner. Lỗi `VITE_NETWORK="..." has no entry`: giá trị chỉ được là `localhost` hoặc `sepolia`, build lại A5.

Các route (`web3/src/App.tsx`):

| Route | Đăng nhập API | Ví | Nội dung |
|---|---|---|---|
| `/` | có | tùy | Danh sách thiết bị |
| `/d/:deviceId` | có | không | Thiết bị, danh sách incident, lịch sử on-chain |
| `/d/:deviceId/i/:incidentId` | có | có (khi hành động) | Chi tiết incident, xác minh, ack, resolve |
| `/verify/:deviceId/:incidentId` | có | không | Xác minh độc lập |
| `/wallet` | có | có | Số dư ASAFE, stake, unstake, withdraw |
| `/keeper` | không | có | Bảng keeper công khai |
| `/params` | không | không | Tham số và quỹ thưởng (chỉ đọc) |

### B11. Kịch bản A: từ incident đến resolve (Task 5)

Mở route `/d/dc:b4:d9:13:ed:8c` rồi chọn incident vừa tạo ở B7.

| Bước | Làm gì | Đúng khi (theo tài liệu) |
|---|---|---|
| A1 | Mở trang incident (từ app B9 hoặc từ danh sách) | Trang chi tiết mở đúng incident |
| A2 | Quan sát trạng thái | Từ "Đang đưa lên chain" sang "Đã ghi on-chain" |
| A3 | Bấm **Xác minh** | 4 dòng pass: `deviceIdHash`, `incidentId`, `evidenceHash` (so chain với `hashEvidence()`), `signer`. Điểm nói: không cần tin server |
| A4 | Kết nối MetaMask bằng ví owner | Nút **Xác nhận** xuất hiện |
| A5 | Bấm Xác nhận, ký trong MetaMask | Trạng thái chạy `simulate`, `pending`, `confirmed`, rồi incident sang acknowledged. Etherscan có event `IncidentAcknowledged` |
| A6 | Đổi sang ví khác trong MetaMask | Nút **Xác nhận** biến mất |
| A7 | Quay lại ví owner, bấm **Đã xử lý** | Incident sang resolved. Tab Lịch sử có 3 event: Logged, Acknowledged, Resolved. Etherscan có `IncidentResolved` |

Mỗi giao dịch Sepolia mất khoảng 15 đến 60 giây.

**Sai thì:**
- Nút "Review alerts" của MetaMask bị xám: lỗi extension MetaMask đã được xác nhận, không phải code dự án (ghi trong `tmp/05_reports/2026-10-02_task5-progress-report.md`). Tải lại trang và thử lại.
- Giao dịch revert với báo lỗi tiếng Việt: bảng lỗi nằm ở mục 6 của `tasks/Web3_task.md`.

Lưu ý: tiêu chí hoàn thành M3 của Task 5 là chạy trọn kịch bản này trên Sepolia thật bằng MetaMask. Chưa có bằng chứng trong ghi chú nhóm là đã chạy trọn. Hãy chạy thử một lần trước ngày demo.

### B12. Task 8 live: stake và thưởng trên Sepolia

Điều kiện: A8 đã xong (ví owner có ASAFE).

| Bước | Làm gì | Đúng khi (theo tài liệu) |
|---|---|---|
| 1 | Mở `/params` (không cần đăng nhập) | Bảng tham số: `ownerBond` 100 ASAFE, `ackReward` 5, `resolveReward` 5, `dailyRewardCap` 3, `unstakeCooldown` 7 ngày. Các giá trị này khớp `blockchain/deployments/sepolia.incentives.json` |
| 2 | Mở `/wallet` | Số dư ASAFE của ví owner đọc từ chain, bằng `200` nếu A8 đã chuyển 200 |
| 3 | Stake 100 ASAFE cho thiết bị | dApp làm 2 giao dịch (approve đúng số lượng, rồi stake), ký 2 lần trong MetaMask. Số dư giảm 100, stake hiện 100 |
| 4 | Tạo incident mới (lặp B7), rồi **ack trong hạn** | Hạn ack 30 phút (mức warning) hoặc 10 phút (mức danger) tính từ `loggedAt`. Sau khi ack được xác nhận, dApp đọc `canRecordAck` (`web3/src/pages/IncidentPage.tsx`): nếu còn `true` thì mở thêm một lần ký MetaMask cho `recordTimelyAck`, phải ký trong hạn ack. Keeper (`KEEPER_ENABLED=true`) cũng ghi nhận sau khi indexer thấy ack (khoảng 1 phút); bên nào vào trước thì bên kia gặp `AlreadySettled` hoặc báo "đã stale", đó là kết quả bình thường. Nhãn `+5` hiện khi một trong hai xong |
| 5 | Bấm **Đã xử lý** trong 24 giờ | Giống bước 4 với `recordTimelyResolve` (có thể có thêm một lần ký MetaMask, hoặc keeper ghi nhận thay). Nhãn thưởng resolve `+5`, số dư ở `/wallet` tăng 10 so với trước |
| 6 | Mở `/keeper` | Bảng công khai hiện các mục "Quá hạn acknowledge" và "Relay trễ" (có thể rỗng nếu không có incident quá hạn) |

Phạt P1 và P2 trên Sepolia cần chờ hết hạn thật (10 đến 30 phút), không phù hợp demo live. Trình bày P1, P2, trần ngày và cooldown bằng B6.

Unstake có cooldown 7 ngày (`unstakeCooldown` 604800 giây), nên không withdraw được trong buổi demo.

---

# Phần C. Dự phòng

## C1. Chạy local trên hardhat (không cần board hay Sepolia)

Dùng khi tầng 2 hỏng hoặc không có `.env` Sepolia. Cần khôi phục `server/.env` về bản hardhat nếu đã thay: `cp server/.env.hardhat-local server/.env`. Chưa chạy lại hôm nay; `tmp/05_reports/2026-10-02_task5-progress-report.md` ghi kịch bản A đã pass trên hạ tầng local thật.

**Lệnh, terminal 1 (để yên, không tắt)**
```bash
cd blockchain
npx hardhat compile
npm run node
```
**Đúng khi (theo tài liệu):** in danh sách `Account #0 ... Account #19` và `Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/`.

**Lệnh, terminal 2**
```bash
make e2e-chain-local
```
**Đúng khi (theo tài liệu `E2E_GUIDE_SERVER_ENV_HOLDER.md`, Mức 1):** có `ℹ pass 12` và `ℹ fail 0`.

**Lệnh, terminal 2 (tiếp)**
```bash
make server-up
cd server && docker compose --profile chain up -d chain-worker && cd ..
cd web3 && npm run test:e2e
```
**Đúng khi (theo tài liệu):** Playwright báo kịch bản A pass (`passed`, không có `failed`). Cần hardhat node **và** stack Docker (postgres, redis, emqx, api, chain-worker) đang chạy. Test chạy trên `http://127.0.0.1:5174/dapp/` với `VITE_NETWORK=localhost` và ví giả bằng mock connector.

## C2. Task 8 độc lập

Giống B6: `cd web3 && npm run test:incentives-e2e`, đúng khi `1 passed`. Đây là phương án dự phòng chắc nhất vì đã chạy thành công, không cần Docker.

## C3. Bằng chứng đã nằm sẵn trên Sepolia (không cần chạy gì)

| Bằng chứng | Link hoặc giá trị |
|---|---|
| AirSafetyLog events | `https://sepolia.etherscan.io/address/0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A#events` |
| Deploy AirSafeToken | tx `0x967445ea3d96707390156d2a817d364baddb64aa30a9cd37747aca6228558b9d`, block 11834177 |
| Deploy SafetyIncentives | tx `0xa1605adc85bceae68ae352cafe7886cc287c5329bba05e2fb75346289d2a49db`, block 11834182 |
| Kit `dc:b4:d9:13:ed:8c` | sequence 6 đến 9 đã `confirmed` (theo `docs/tasks/Task5_8_plan.md`) |

Kiểm tra nhanh trạng thái thật của kit trên chain, không cần server:
```bash
cd blockchain && node -e '
const {ethers}=require("ethers");
(async()=>{const p=new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com",11155111,{staticNetwork:true});
const abi=require("./abi/AirSafetyLog.json");
const c=new ethers.Contract("0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A",abi.abi||abi,p);
const d=await c.getDevice(ethers.keccak256(ethers.toUtf8Bytes("dc:b4:d9:13:ed:8c")));
console.log(d.toString());})()'
```
**Đúng khi `(đã chạy)`:** in
```text
0x510d00963bd8F76F5356d42042f7e250a6683F93,0x4aC8fe56c966496a12fCDEc5a1B01c21a97CF30B,11,true,true,true
```
Thứ tự: signer, owner, `lastSequence`, `hasLogged`, `active`, `exists`. `lastSequence` sẽ lớn hơn 11 nếu đã có incident mới.

## C4. Video quay sẵn

Mở các đoạn đã quay ở A9.

---

# Phần D. Phụ lục

## D1. Thông tin cố định

| Mục | Giá trị |
|---|---|
| AirSafetyLog (Sepolia) | `0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A` |
| AirSafeToken ASAFE (Sepolia) | `0xD01324896e7cCc099DB95212a54b5473a3B2DE34` |
| SafetyIncentives (Sepolia) | `0x4078c3a86708B4C4B3aD61aB5A282e0E6A9FAA04` |
| Admin / Treasury | `0x7Ee5fAD36702a5228E60D8CDE6Be3FE91f5B1a3F` |
| Relayer (là Operator) | `0xe9426f8AbFf21ddb99a4Ca383c2b71D9AF95197d` |
| Device manager | `0x106ce92E3664AeD1330c183aFdF2D5Ff7618D29A` |
| Ví owner (MetaMask) | `0x4aC8fe56c966496a12fCDEc5a1B01c21a97CF30B` |
| Ví keeper | địa chỉ in ở A4 lệnh 5 (khóa nằm trong `server/.env`, `KEEPER_PRIVATE_KEY`) |
| Kit | device_id `dc:b4:d9:13:ed:8c`, signer `0x510d00963bd8F76F5356d42042f7e250a6683F93` |
| Domain public | `https://minhnhat05.xyz` (API `/api`, MQTT `/mqtt`, dApp `/dapp/`) |
| ESP-IDF | `/home/nhat/workspace/esp-idf` (v5.4.2) |

Số dư ETH tại 2026-10-03 (`(đã chạy)`): admin 0.092, relayer 0.099, manager 0.0999, owner 0.05. Relayer dưới 0.05 ETH sẽ bị cảnh báo `relayer_low_balance`. Quỹ thưởng 50000 ASAFE, operator bond 1000 ASAFE, SafetyIncentives đang giữ 51000 ASAFE.

Luồng hệ thống:
```text
ESP32-S3 (ký EIP-712) -> MQTT/WSS -> EMQX -> API (outbox) -> chain-worker (relayer)
  -> AirSafetyLog (Sepolia) -> indexer -> API -> dApp (web3/) và app điện thoại (app/)
                         SafetyIncentives + AirSafeToken (ASAFE) <- dApp /wallet, /keeper
```

## D2. Sau demo

**Lệnh**
```bash
cd server
docker compose --profile chain stop chain-worker
cd .. && make server-down
```
**Đúng khi:** `docker ps` không còn container `sa-*`.

Các việc còn lại:
- Báo người giữ `.env` rằng worker của bạn **đã dừng**, để họ chạy lại worker của họ.
- Flash lại bản production cho kit (bỏ chế độ replay), giữ NVS:
  ```bash
  cd firmware && . /home/nhat/workspace/esp-idf/export.sh
  idf.py -B build-incident -p /dev/ttyACM0 app-flash
  ```
- Ví keeper: giữ lại nếu còn dùng, hoặc xóa dòng `KEEPER_PRIVATE_KEY` và đặt `KEEPER_ENABLED=false`. Số ETH còn lại trong ví keeper không tự về, cần gửi lại bằng khóa đó.
- Trả lại `server/.env`: muốn về cấu hình local thì `cp server/.env.hardhat-local server/.env`; xóa bản `.env` Sepolia theo thỏa thuận với người giữ.
- Build lại dApp cho local nếu cần: `cd web3 && VITE_NETWORK=localhost VITE_API_BASE_URL=http://127.0.0.1:3000/api VITE_RPC_URL=http://127.0.0.1:8545 npm run build`.

## D3. Sự cố thường gặp

| Triệu chứng | Nguyên nhân | Xử lý |
|---|---|---|
| `https://minhnhat05.xyz/...` trả 530 | Stack chưa chạy, hoặc `cloudflared` lỗi | `make server-up`, `docker logs sa-cloudflared` |
| `adb devices` rỗng | Chưa bật USB debugging, cáp chỉ sạc | Đổi cáp, chấp nhận hộp thoại trên điện thoại |
| `outbox` ra `waiting_signer` | Signer chưa active, hoặc worker không chạy | A10 lệnh 5, `docker ps` kiểm tra `sa-chain-worker` |
| `outbox` ra `legacy_domain` | `.env` hoặc firmware dùng domain cũ | `INCIDENT_DEPLOYMENT=sepolia`, firmware build có `CONFIG_SA_INCIDENT_ENV_SEPOLIA=y` |
| dApp banner wrong RPC hoặc domain | MetaMask có mạng tùy chỉnh trùng chain ID 11155111 | A10 lệnh 6, không bỏ qua guard |
| Worker thoát, exit code 2 | Mất role, RPC hoặc domain sai | `docker logs sa-chain-worker`, xem `ops/CHAIN_WORKER_RUNBOOK.md` |
| Worker thoát exit code 2, log có `keeper wallet ... is also the ...` hoặc `has no ETH for gas` | Ví keeper trùng relayer, manager hoặc operator, hoặc chưa có ETH | Tạo ví keeper mới (A4 lệnh 5) và nạp ETH (A4 lệnh 6) |
| Hai worker chạy cùng lúc | Người giữ `.env` chưa dừng worker | Báo họ dừng, chờ xác nhận |
| `server/api` test fail ở `firmware-wire-contract` | Thiếu `IDF_PATH` | `IDF_PATH=/home/nhat/workspace/esp-idf npm test` |
| Board không kết nối MQTT ở nơi demo | Wi-Fi hội trường chặn hoặc khác SSID đã lưu | Dùng hotspot đã provision (A7) |

## D4. Kết quả đã chạy thật trên máy này (2026-10-03, commit `2d1f760` cộng các sửa chưa commit ở D5)

| Hạng mục | Lệnh | Kết quả |
|---|---|---|
| Firmware build, profile Sepolia | `idf.py -B build-incident ... build` | Thành công, `smart-air.bin` 0x1684d0, 30% còn trống |
| Firmware build, profile replay | `idf.py -B build-replay ... build` | Thành công, `smart-air.bin` 0x16a670, 29% còn trống |
| Sinh domain EIP-712 | `node spec/incident/gen/gen-all.mjs --check` | `up to date` |
| Contract | `cd blockchain && npm test` | 84 passing (82 cũ và 2 test mô tả giới hạn đã biết) |
| Backend | `IDF_PATH=... npm test` trong `server/api` | 235 pass, 0 fail, 4 skipped |
| dApp unit và tích hợp | `cd web3 && npm run test` | 121 pass, 0 fail, 2 skipped. `npx tsc -b` sạch |
| Task 8 E2E trình duyệt | `cd web3 && npm run test:incentives-e2e` | 1 passed, khoảng 30 giây |
| dApp build cho Sepolia | `vite build` với `VITE_NETWORK=sepolia`, ra thư mục tạm | Thành công, bundle chứa `https://minhnhat05.xyz/api` |
| Contract trên Sepolia | `eth_getCode` qua RPC công khai | Cả 3 contract có bytecode |
| Kit trên contract | `getDevice(keccak256("dc:b4:d9:13:ed:8c"))` | Mục C3 |
| Token | `balanceOf` | Treasury 949000, SafetyIncentives 51000, ví owner 0 |
| Mẫu lệnh kiểm tra receipt | `eth_getTransactionReceipt` với tx deploy token | `"status":"0x1"` |

Chưa chạy trên máy này: flash và monitor trên board, `expo run:android` trên điện thoại, deep-link MetaMask Mobile, kịch bản A trên Sepolia, `npm run test:e2e` (kịch bản A local), `make e2e-chain-local`, `npm run test:deployment`, cấp ASAFE cho ví owner, toàn bộ stack Docker với `.env` Sepolia.

## D5. Việc cần sửa trong repo (không nằm trên đường demo)

| Việc | Chi tiết |
|---|---|
| Đã sửa trong lần review 2026-10-03 (chưa commit) | `web3/src/lib/incentives.test.ts` (test cũ), nút bỏ giao dịch pending (`useIncentiveTransaction.ts`, `IncentivesShared.tsx`), `keeper.js` kiểm tra `staker == owner`, comment `relayer.js`, 2 test mới trong `blockchain/test/incentives.test.js`, mục "Giới hạn đã biết" trong `docs/tasks/Token_incentive_task.md` |
| Đã sửa tiếp (chưa commit) | `Makefile` (5 target `app-*` sang Expo, `IDF_EXPORT` tự tìm đường dẫn), `app/package.json` và `app/package-lock.json` (`name` thành `app`), mục 3.6 của `docs/ops/E2E_GUIDE_SERVER_ENV_HOLDER.md`. Đã chuyển hai file lẻ ở thư mục gốc vào đúng chỗ trong `docs/`: bản cũ của `E2E_GUIDE_SERVER_ENV_HOLDER.md` và file trỏ `Task5_8_plan.md` đã bị xóa, bản chính nằm ở `docs/ops/` và `docs/tasks/` |
| Còn tồn | `README.md` (huy hiệu Flutter, mô tả "App (Flutter + Riverpod)"), `docs/architecture/ARCHITECTURE*.md` (vẫn mô tả app Flutter) |
| `docs/_RUN_BOOK.md` và `docs/ops/_RUN_BOOK.md` | Trùng tên, khác mục đích (kịch bản demo và vận hành server) |
