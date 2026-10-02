# web3 -- incident + token/bond/incentives dApp (Task 5 + Task 8)

## Task 8 — incentives

`/dapp/wallet` (đăng nhập) đọc token balance/allowance trực tiếp từ chain,
approve đúng số lượng rồi stake; unstake/withdraw theo cooldown canonical.
Device và incident giữ riêng trạng thái chain và API indexed/projection.
`/dapp/keeper` và `/dapp/params` là các trang public. Keeper action luôn đọc
lại eligibility và simulate trước khi ký; P2 chỉ chạy khi người dùng bấm,
không thêm automation phía server. Receipt confirmed không bị đổi thành
failed khi API chậm. Transaction pending lưu theo mạng/contract/ví/target
và có thể resume mà không gửi lại transaction.

Deployment incentives lấy từ generator chung; chạy `npm run sync-abi`,
hoặc `npm run sync-abi -- --check` để kiểm tra drift. Nếu chưa có
`blockchain/deployments/sepolia.incentives.json`, UI báo unavailable,
không dùng địa chỉ giả. Không có admin/private-key transaction trong dApp.

Gate browser Task 8 độc lập:

```bash
npx playwright install chromium
npm run test:incentives-e2e
```

Harness dùng Hardhat thật (`18545`), API/indexer/relayer Task 7 thật trên
PGlite (`3006`) và Vite (`5176`); chỉ login fixture và connector ví test.
Receipt deployment vừa tạo được đưa vào module tạm `.incentives-e2e/`
qua config Vite riêng, không đổi artifact production hay bỏ qua domain guard.
Scenario đi qua UI: approve/stake, evidence verify, ack/resolve R1/R2,
P1, P2 manual, daily cap, insufficient reward fund và cooldown/withdraw.
Không cần EMQX/Sepolia, không thao tác incident production.

Vite + React + TypeScript + wagmi/viem. Xem `docs/reference/ATMOSPHERE_WEB_DESIGN.md`
(UI) và `tmp/02_decisions/2026-10-01_task5-dapp-incident-decisions.md` (21
quyết định kỹ thuật) ở repo root trước khi sửa code ở đây.

## Chạy local

```bash
npm install
cp .env.example .env.local   # sửa VITE_NETWORK/VITE_RPC_URL nếu cần
npm run dev
```

Vite dùng cùng canonical base path như production: `http://127.0.0.1:5173/dapp/`.

Các biến runtime bắt buộc của frontend:

```dotenv
VITE_NETWORK=localhost          # hoặc sepolia
VITE_RPC_URL=http://127.0.0.1:8545
VITE_API_BASE_URL=http://127.0.0.1:3000/api
```

Với local Hardhat, chạy `cd blockchain && npm run node`, deploy canonical
contract theo workflow của project rồi mở `/dapp/`; MetaMask phải trỏ đúng RPC
local và import/fund account cần thao tác. Với Sepolia, đặt `VITE_NETWORK=sepolia`
và dùng RPC Sepolia, nhưng không deploy lại từ dApp. Localhost và Sepolia cố ý
dùng cùng chain ID `11155111`, nên chain ID **không đủ** để nhận diện mạng:
dApp còn kiểm tra EIP-712 domain, bytecode và deployment receipt. Nếu thấy banner
wrong RPC/domain, kiểm tra `VITE_NETWORK`, `VITE_RPC_URL`, địa chỉ deployment và
xóa/sửa network RPC trùng chain ID trong MetaMask; không bỏ qua guard.

Regenerate `src/generated/incident-deployments.ts` sau khi deploy contract
mới: `node ../spec/incident/gen/gen-all.mjs` (chạy từ repo root).

## Test

```bash
npm run test       # Vitest -- unit + smoke render + integration (mock connector, hardhat)
npm run build && npm run test:deployment # asset + SPA fallback thật dưới /dapp/
npm run test:e2e   # Playwright -- kịch bản A thật qua trình duyệt (xem dưới)
```

Unit/integration suite có các gate P1: EIP-712 recovery độc lập (gồm signer
rotation và API signer sai), mutation từng field của hai evidence vector, SSE
reconnect/dedupe/fallback polling, cursor pagination, trạng thái RPC riêng biệt
và boundary `eth_getLogs` 1.999/2.000/2.001 block.

## Phát hành qua nginx

Không copy artifact bằng tay. Chạy `npm run build` trong `web3/`, sau đó chạy
`docker compose up -d nginx` trong `server/`. Compose mount read-only chính xác
`web3/dist` vào `/var/www/dapp`; nginx phục vụ `/dapp/` và fallback mọi route SPA
về `/dapp/index.html`.

`npm run test:e2e` (`e2e/scenario-a.spec.ts`) tự khởi động một `vite` dev
server riêng (cổng `5174`, không đụng cổng `5173` bạn đang dùng tay) với
`VITE_E2E_MOCK_ACCOUNT` đặt sẵn -- `src/lib/wagmiConfig.ts` khi thấy biến này
dùng connector `mock()` của wagmi thay vì `injected()`, nên **không cần cài
MetaMask** để chạy test này (đúng quyết định #9 + mục 9 "E2E UI" của
`docs/tasks/Web3_task.md`: mock connector, không phải MetaMask thật).

Cần dựng sẵn trước khi chạy (giống mọi test trong `server/api/test/e2e/*`):
```bash
cd blockchain && npx hardhat node --hostname 0.0.0.0   # giữ chạy
cd server && docker compose up -d postgres redis emqx api
docker compose up -d --profile chain chain-worker       # sau khi contract đã deploy ở địa chỉ trong spec/incident/deployments/localhost.json
```
Test tự tạo user/home/device mới qua API thật, đăng ký device thẳng lên
contract (bỏ qua hàng đợi chain-worker để nhanh), kích hoạt signer thẳng
trong DB, rồi publish một incident ký EIP-712 thật qua MQTT/TLS -- không có
gì bị mock ở tầng backend/chain, chỉ có bước ký ví (B1/B5) dùng mock connector
thay MetaMask. Nếu không thấy backend sẵn sàng ở `http://127.0.0.1:3000`,
test tự `skip` với lý do rõ ràng thay vì fail cứng.

Kịch bản browser đi qua deep-link trước login, ví không phải owner, account
switch sang owner, verify 4 checks, acknowledge, reload khi transaction còn
pending/indexing, resolve, rồi kiểm tra history. Realtime dùng một SSE stream
`/api/realtime`; polling 10 giây chỉ là fallback khi stream disconnect.

CORS: thêm `http://127.0.0.1:5174` vào `CORS_ORIGINS` (cùng với `5173`) khi
chạy test này, nếu không trình duyệt headless sẽ bị chặn gọi API.

## Known limitation (quyết định #5)

B3 (danh sách incident) lấy danh sách ID từ `GET /api/devices/:id/incidents`
-- nó **tin API về việc liệt kê đủ incident**. Mỗi incident hiển thị vẫn
được xác minh độc lập với chain (B4: hash, chữ ký, trạng thái), nhưng nếu
backend bỏ sót một incident khỏi danh sách, B3 sẽ không biết. Chỉ **B6**
(lịch sử on-chain, đọc trực tiếp bằng `getLogs`) là lớp phát hiện đầy đủ
không cần tin server. Quyết định có chủ đích không thêm logic đối chiếu số
lượng vào B3 cho M1-M3 (chi phí/lợi ích không đủ cấp thiết lúc chốt quyết
định) -- xem lý do đầy đủ ở quyết định #5.
