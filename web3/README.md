# web3 -- dApp xem/verify/acknowledge/resolve incident (Task 5)

Vite + React + TypeScript + wagmi/viem. Xem `docs/ATMOSPHERE_WEB_DESIGN.md`
(UI) và `tmp/02_decisions/2026-10-01_task5-dapp-incident-decisions.md` (21
quyết định kỹ thuật) ở repo root trước khi sửa code ở đây.

## Chạy local

```bash
npm install
cp .env.example .env.local   # sửa VITE_NETWORK/VITE_RPC_URL nếu cần
npm run dev
```

Regenerate `src/generated/incident-deployments.ts` sau khi deploy contract
mới: `node ../spec/incident/gen/gen-all.mjs` (chạy từ repo root).

## Test

```bash
npm run test       # Vitest -- unit + smoke render + integration (mock connector, hardhat)
npm run test:e2e   # Playwright -- kịch bản A thật qua trình duyệt (xem dưới)
```

`npm run test:e2e` (`e2e/scenario-a.spec.ts`) tự khởi động một `vite` dev
server riêng (cổng `5174`, không đụng cổng `5173` bạn đang dùng tay) với
`VITE_E2E_MOCK_ACCOUNT` đặt sẵn -- `src/lib/wagmiConfig.ts` khi thấy biến này
dùng connector `mock()` của wagmi thay vì `injected()`, nên **không cần cài
MetaMask** để chạy test này (đúng quyết định #9 + mục 9 "E2E UI" của
`Web3_task.md`: mock connector, không phải MetaMask thật).

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
