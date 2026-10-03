# ARCHITECTURE_APP.md

Tài liệu này mô tả kiến trúc ứng dụng Flutter hiện đang được implement trong `smart-air` tại thời điểm hiện tại của repo. Nội dung chỉ bám vào app runtime, cấu trúc mã nguồn, và các ranh giới tích hợp đã thấy trong code; không mô tả target architecture, roadmap, hay đề xuất tương lai.

## 1. Vai trò của app

App là runtime phía người dùng cho các trách nhiệm sau:

- xác thực người dùng và khôi phục phiên đăng nhập
- hiển thị danh sách nhà, phòng, thiết bị, dashboard thiết bị, và lịch sử lệnh
- provision thiết bị mới qua BLE + HTTP cục bộ của thiết bị + API cloud
- gửi command, đọc shadow, đọc telemetry lịch sử, và hiển thị telemetry live
- nhận sự kiện realtime từ API qua SSE rồi cập nhật UI
- dựng thông báo vận hành từ REST history và realtime events
- áp dụng design system `Atmosphere` cho theme, tokens, atoms, và shell navigation

Ở trạng thái hiện tại, app nhắm tới Android/iOS. `main.dart` chặn runtime web bằng một màn hình "Web Not Supported", vì provisioning flow phụ thuộc BLE.

## 2. Bootstrap runtime

Bootstrap của app hiện tại diễn ra theo chuỗi sau:

1. `main()` tắt Google Fonts runtime fetching để chỉ dùng font đã bundle
2. `Env.validate()` kiểm tra `API_BASE_URL` và `MQTT_BROKER_URI` là absolute URI hợp lệ
3. nếu chạy trên web thì render `_WebUnsupportedApp`
4. nếu không phải web thì khởi động `ProviderScope(child: SmartAirApp())`
5. `SmartAirApp` đọc `routerProvider` và dựng `MaterialApp.router`
6. `MaterialApp.router` lấy `themeMode` từ `AppState.themeMode`, còn light/dark theme đến từ `AtmosphereTheme`

Kiến trúc bootstrap này có hai điểm đáng chú ý:

- state quản lý theme toàn app hiện không đi qua Riverpod; nó dùng `ValueNotifier<ThemeMode>` trong `AppState`
- biến môi trường vẫn có trường `MQTT_BROKER_URI`, nhưng app runtime hiện không mở kết nối MQTT trực tiếp; luồng dữ liệu live thực tế là REST + SSE

## 3. Phân tầng mã nguồn

App hiện được tổ chức theo các tầng chính sau:

| Tầng | Vai trò hiện tại | Ví dụ |
| --- | --- | --- |
| `app/lib/core/` | bootstrap helpers, env/config, router, auth interceptor, secure storage | `router.dart`, `api_client.dart`, `auth_interceptor.dart`, `env.dart` |
| `app/lib/services/` | adapter tới API server, SSE stream, BLE, và HTTP cục bộ của thiết bị | `auth_service.dart`, `device_service.dart`, `realtime_service.dart`, `ble_service.dart` |
| `app/lib/providers/` | orchestration state bằng Riverpod `AsyncNotifierProvider` và `StreamProvider` | `auth_provider.dart`, `devices_provider.dart`, `homes_provider.dart`, `notifications_provider.dart` |
| `app/lib/models/` | kiểu dữ liệu domain và realtime payloads | `device.dart`, `home.dart`, `command.dart`, `telemetry.dart`, `realtime_event.dart` |
| `app/lib/screens/` | màn hình người dùng và wizard provisioning | `home_screen.dart`, `device_dashboard_screen.dart`, `step1_power_on.dart` |
| `app/lib/widgets/` | shell, atoms, cards, fields, bottom nav, reusable UI primitives | `widgets/shell/app_shell.dart`, `widgets/shell/ble_step_shell.dart` |
| `app/lib/design/` | design tokens, palette, theme, typography, icons | `tokens.dart`, `palette.dart`, `atmosphere_theme.dart`, `text_styles.dart` |

Ở mức kiến trúc, `services` chịu trách nhiệm giao tiếp bên ngoài, `providers` chịu trách nhiệm state orchestration, còn `screens/widgets` là tầng trình bày.

```mermaid
flowchart LR
    UI["screens + widgets"] --> Providers["Riverpod providers"]
    Providers --> Services["services"]
    Services --> Core["core config / Dio / secure storage / router"]
    Services --> API["Cloud API"]
    Services --> SSE["SSE /realtime"]
    Services --> BLE["BLE provisioning"]
    Services --> LocalHTTP["local HTTP /api/info + /api/config"]
    Models["models"] --> Providers
    Design["Atmosphere design system"] --> UI
```

## 4. Routing và navigation

`app/lib/core/router.dart` là source of truth cho route map đang hoạt động.

### 4.1 Public routes

- `/` -> `SplashScreen`
- `/login` -> `LoginScreen`
- `/register` -> `RegisterScreen`

`redirect` của `GoRouter` đọc `authProvider` để áp policy:

- khi `authProvider` đang `isLoading`, router không redirect để tránh flash `/login`
- nếu chưa đăng nhập thì chỉ cho vào các route public
- nếu đã đăng nhập mà vào `/login` hoặc `/register` thì redirect về `/home`

### 4.2 Shell routes

App dùng `StatefulShellRoute.indexedStack` để giữ persistent bottom navigation cho ba tab chính:

- `/home`
- `/notifications`
- `/profile`

`AppShell` bọc `StatefulNavigationShell` và render `AtmosphereBottomNav`, nên state của từng branch được giữ theo semantics của `indexedStack`.

### 4.3 Drill-down routes

Các route drill-down nằm ngoài shell, nên khi vào các màn hình này app không còn bottom nav:

- `/homes`, `/homes/create`, `/homes/:homeId`
- `/devices/:id`
- `/devices/:id/commands`
- `/devices/:id/settings`
- `/devices/:id/calibrate/:sensor`
- `/devices/:id/ota`
- `/profile/home/:homeId`

### 4.4 Provisioning routes

Wizard provisioning là một flow 5 bước, truyền state chủ yếu qua query params:

- `/provision`
- `/provision/scan`
- `/provision/wifi`
- `/provision/announce`
- `/provision/name`

Những route này truyền `homeId`, `mac`, `deviceId`, và trong một số bước có thêm `ssid`.

```mermaid
flowchart TD
    Splash["/"] --> Auth["/login + /register"]
    Auth --> Shell["StatefulShellRoute.indexedStack"]
    Shell --> Home["/home"]
    Shell --> Notifications["/notifications"]
    Shell --> Profile["/profile"]
    Shell --> Homes["/homes + /homes/:homeId"]
    Shell --> Device["/devices/:id + child routes"]
    Shell --> Provision["/provision -> /scan -> /wifi -> /announce -> /name"]
```

## 5. Kiến trúc auth và session

### 5.1 Session model

Auth hiện dùng mô hình:

- `accessToken` giữ trong memory qua biến module-level của `auth_interceptor.dart`
- `refreshToken` giữ trong `FlutterSecureStorage`
- JSON của `User` cũng được persist trong `FlutterSecureStorage`

`authProvider` là `AsyncNotifierProvider<AuthNotifier, User?>`. Trong `build()`:

1. lấy `refreshToken`
2. lấy `user_json`
3. nếu có đủ dữ liệu thì khôi phục user ngay tại local, không gọi network

Điều này có nghĩa là restore session hiện là optimistic local restore; request API đầu tiên mới là nơi interceptor quyết định token còn dùng được hay không.

### 5.2 Auth interceptor

`AuthInterceptor` gắn vào `Dio` global và chịu ba trách nhiệm:

- thêm `Authorization: Bearer <accessToken>` vào request thường
- chặn 401 từ non-auth endpoint để gọi `/auth/refresh`
- force logout khi refresh thất bại hoặc refresh token không hợp lệ

`forceLogoutSignalProvider` là cầu nối giữa interceptor và tầng state. Khi force logout xảy ra, `authProvider` lắng nghe signal này để:

- đặt session state về `null`
- invalidate các provider phụ thuộc phiên như `devicesProvider`, `homesProvider`, `roomsProvider`, và `realtimeEventsProvider`

### 5.3 Auth service boundary

`AuthService` là adapter typed cho các endpoint:

- `POST /auth/login`
- `POST /auth/register`
- `POST /auth/refresh`
- `POST /auth/logout`

Tầng service này chịu trách nhiệm parse payload và map `DioException` sang `AppException` cụ thể.

## 6. Kiến trúc state với Riverpod

State runtime hiện dựa chủ yếu trên Riverpod `AsyncNotifierProvider`, cộng thêm một `StreamProvider.autoDispose` cho realtime.

### 6.1 Global state chính

- `authProvider`: user hiện tại
- `homesProvider`: danh sách nhà
- `roomsProvider(homeId)`: danh sách phòng theo nhà
- `devicesProvider`: danh sách thiết bị của user
- `notificationsProvider`: danh sách thông báo cho UI
- `realtimeEventsProvider`: nguồn event live từ SSE
- `realtimeConnectionStatusProvider`: trạng thái kết nối realtime

### 6.2 Device-scoped state

App tách state theo từng `deviceId` bằng `family` providers:

- `shadowProvider(deviceId)`
- `commandsProvider(deviceId)`
- `otaCatalogProvider(deviceId)`
- `telemetryProvider(params)`
- `telemetryLiveProvider(deviceId)`
- `telemetryHistoryProvider(params)`

Các provider dạng `autoDispose family` giúp dashboard và màn drill-down chỉ giữ state khi màn hình còn được dùng.

### 6.3 Mô hình đồng bộ state

Kiến trúc state hiện không phải realtime-first hoàn toàn. Phần lớn luồng dùng mô hình:

1. lấy snapshot ban đầu qua REST
2. subscribe vào `realtimeEventsProvider`
3. patch state cục bộ khi event phù hợp xuất hiện

Ví dụ:

- `devicesProvider` patch `online`, `firmwareVer`, `mode`, `relay_1..3` từ `device.status` và `shadow.reported`
- `shadowProvider` merge `reported` + `patch` khi có `shadow.reported`
- `commandsProvider` insert hoặc update command khi có `command.updated`
- `telemetryLiveProvider` append `telemetry.point` vào chuỗi live hiện tại
- `notificationsProvider` sinh notification UI mới từ `device.status`, `command.updated`, và `ota.progress`

Kiến trúc này giữ REST là snapshot truth ban đầu, còn SSE là delta stream để làm tươi UI.

## 7. Tầng service và ranh giới giao tiếp

### 7.1 HTTP client chung

`dioProvider` tạo `Dio` global với:

- `baseUrl = Env.apiBaseUri`
- timeout connect/send/receive 10 giây
- `Content-Type: application/json`
- `AuthInterceptor`

Đây là HTTP client mặc định cho toàn bộ cloud API.

### 7.2 REST services

Các adapter chính hiện tại:

- `AuthService` cho auth
- `HomeService` cho `/homes`, `/rooms`, và invite member
- `DeviceService` cho `/devices`, `/shadow`, `/command`, `/devices/:id/ota*`, telemetry, provisioning cloud handoff, và announce polling
- `NotificationService` cho `/notifications`

App hiện không có service nào mở MQTT socket trực tiếp.

### 7.3 SSE realtime service

`RealtimeService.watchEvents()` dùng chính `Dio` để `GET /realtime` với:

- `Accept: text/event-stream`
- `ResponseType.stream`
- `Last-Event-ID` khi reconnect

Luồng realtime có các đặc tính sau:

- retry với exponential backoff từ 1 giây tới tối đa 30 giây
- nếu nhận `replay.reset` thì đánh dấu trạng thái `degraded`
- nếu gặp `AuthException` hoặc 401 thì dừng stream và để auth flow xử lý logout/redirect

`SseDecoder` là parser custom cho SSE frame, chịu trách nhiệm:

- bỏ qua comment frames
- ghép nhiều dòng `data:`
- parse JSON payload
- đổ `id` và `event` của SSE vào `RealtimeEvent`

## 8. Kiến trúc provisioning

Provisioning là phần app có boundary phức tạp nhất vì nó nói chuyện với ba phía khác nhau:

- BLE của thiết bị
- HTTP cục bộ trên IP của thiết bị
- cloud API của `smart-air`

```mermaid
sequenceDiagram
    participant App as Flutter app
    participant BLE as BLE device
    participant API as Fastify API
    participant Local as http://device-ip
    participant Cloud as announce endpoint

    App->>BLE: scan + connect + write SSID/password
    BLE-->>App: notify device_id + ip
    App->>API: POST /devices
    API-->>App: secret_key + device metadata
    App->>Local: GET /api/info
    App->>Local: POST /api/config
    loop cho tới khi online hoặc timeout
        App->>Cloud: GET /devices/announce/:deviceId
        Cloud-->>App: announced=true/false
    end
    App->>API: updateDevice(name, roomId)
```

### 8.1 Step 1 đến Step 5

Wizard đang được implement thành 5 bước:

1. `Step1PowerOnScreen`: hướng dẫn đưa thiết bị vào provisioning mode
2. `Step2BleScanScreen`: quét BLE và chọn thiết bị
3. `Step3WifiScreen`: gửi SSID/password, gọi cloud API tạo device record, rồi gửi MQTT credentials xuống local HTTP của thiết bị
4. `Step4CloudScreen`: poll cloud để đợi thiết bị announce online
5. `Step5NameScreen`: đổi tên cuối cùng và gán vào room trước khi mở dashboard

### 8.2 BLE boundary

`BleService` là singleton quản lý toàn bộ vòng đời BLE:

- xin permission với `permission_handler`
- scan bằng `flutter_blue_plus`
- lọc tên thiết bị theo `SMART_AIR_` hoặc legacy prefix `SmartAir-`
- connect theo `remoteId`
- discover GATT service và write credentials vào các characteristics provisioning

UUID provisioning được giữ ở `BleConfig`:

- service: `0000fffe-0000-1000-8000-00805f9b34fb`
- SSID char: `0000ff01-0000-1000-8000-00805f9b34fb`
- password char: `0000ff02-0000-1000-8000-00805f9b34fb`
- notify char: `0000ff03-0000-1000-8000-00805f9b34fb`

Sau khi ghi SSID/password, app chờ notify JSON từ thiết bị để lấy:

- `device_id`
- `ip`
- `status`

### 8.3 Cloud registration + local credential handoff

Ngay sau khi BLE trả về `device_id` và `ip`, app chuyển sang boundary cloud:

1. gọi `DeviceService.provisionDevice(...)` lên API server để tạo/cập nhật device record và lấy `secret_key`
2. nếu thiết bị đã tồn tại, app kiểm tra case `409 Device already registered`
3. nếu có `secret_key`, app mở HTTP client cục bộ tới `http://<device-ip>`
4. app poll `GET /api/info` để chắc local provisioning API đã sẵn sàng
5. app `POST /api/config` để gửi `device_id`, `secret_key`, và optional `broker_uri`

Kiến trúc này nghĩa là app đóng vai trò cầu nối giữa trust bootstrap cục bộ và device registration trên cloud.

### 8.4 Announce polling

`Step4CloudScreen` không đợi push trực tiếp từ BLE hay local HTTP. Nó poll API:

- `GET /devices/announce/:deviceId`

mỗi 2 giây, tối đa 60 giây. Khi API báo `announced = true`, flow mới chuyển sang bước đặt tên.

### 8.5 Final naming

Ở bước cuối, app:

- gọi `updateDevice(deviceId, name, roomId)`
- invalidate `devicesProvider`
- `context.go('/devices/:id')`

Tên mặc định của thiết bị được derive từ suffix của `deviceId`.

## 9. Kiến trúc realtime cho dashboard và vận hành thiết bị

### 9.1 Snapshot + delta

Dashboard thiết bị hiện dùng mô hình snapshot + delta:

- snapshot đầu qua REST (`getShadow`, `getCommands`, `getTelemetry`)
- delta sau đó qua `realtimeEventsProvider`

Đây là cách app tránh mở polling dày cho mọi state đang hiển thị.

```mermaid
flowchart LR
    REST["REST snapshot"] --> Providers["devices / shadow / commands / telemetry providers"]
    SSE["GET /realtime"] --> Decoder["SseDecoder + RealtimeEvent"]
    Decoder --> Providers
    Providers --> UI["dashboard / notifications / profile UI"]
    Decoder --> Status["realtime connection status"]
    Status --> UI
```

### 9.2 Device summary

`devicesProvider` lấy danh sách thiết bị một lần từ `GET /devices`, sau đó patch:

- `device.status` để đổi `online`, `lastSeen`, `firmwareVer`
- `shadow.reported` để đổi `mode` và ba relay

### 9.3 Shadow và commands

`shadowProvider(deviceId)` lấy `GET /devices/:id/shadow`, còn update state bằng event `shadow.reported`.

`commandsProvider(deviceId)` lấy `GET /devices/:id/commands` và dùng `command.updated` để:

- insert command mới nếu chưa có
- update status nếu command đã tồn tại
- sort lại theo `createdAt`

### 9.4 Telemetry live và telemetry history

App tách hai nhu cầu telemetry:

- `telemetryProvider` và `telemetryHistoryProvider` cho khoảng thời gian có giới hạn
- `telemetryLiveProvider` cho cửa sổ live 30 phút gần nhất

`telemetryLiveProvider` hiện:

- tải snapshot ban đầu tối đa 720 điểm
- append `telemetry.point` khi SSE đến
- dedupe các điểm trùng hoàn toàn
- refresh lại snapshot khi gặp `replay.reset`
- giữ `RealtimeStatus` hiện tại để UI biết stream đang connected, connecting, disconnected, hay degraded

## 10. Notifications và projection ở tầng app

Notifications hiện có hai nguồn:

- REST history từ `NotificationService.listNotifications()`
- realtime projection cục bộ trong `NotificationsNotifier`

`NotificationsNotifier` biến các event sau thành `NotificationItem` cho UI:

- `device.status`
- `ota.progress`
- `command.updated` khi command đã đi tới trạng thái terminal

Điểm quan trọng ở đây là app không chỉ render raw realtime events. Nó còn map event thành title/body/severity theo ngữ nghĩa UI vận hành.

## 11. Design system và presentation shell

App hiện dùng design system `Atmosphere` làm nền cho presentation layer:

- `AtmosphereTokens`: raw color literals, radius, spacing, shadow
- `AtmospherePalette`: semantic colors light/dark
- `AtmosphereTheme`: `ThemeData` cho light/dark
- `AtmosphereTextStyles`, `AppIcons`, cùng các atoms/cards/fields riêng

Hai shell UI cấp cao đang hoạt động là:

- `AppShell` cho bottom-navigation 3 tab
- `BleStepShell` cho wizard provisioning 5 bước

Quy ước theme hiện tại là:

- dùng `context.colors` cho adaptive colors
- font được bundle local trong `assets/fonts/`
- `GoogleFonts.config.allowRuntimeFetching = false`

## 12. Kiểm thử và golden strategy

Phần app hiện có ba lớp kiểm thử rõ ràng:

### 12.1 Service/parser tests

Ví dụ:

- `app/test/auth_service_test.dart`
- `app/test/realtime_service_test.dart`
- `app/test/device_service_test.dart`

Các test này kiểm tra parse payload, mapping exception, và parser SSE.

### 12.2 Provider tests

Ví dụ:

- `app/test/devices_provider_test.dart`
- `app/test/telemetry_live_provider_test.dart`
- `app/test/notifications_provider_test.dart`

Các test này kiểm tra cách provider merge snapshot REST với realtime updates.

### 12.3 Golden tests

Golden infra nằm ở `app/test/goldens/`:

- atoms golden tests
- primary screen golden tests
- baseline PNG đã commit trong `test/goldens/goldens/`

Chiến lược hiện tại là:

- `flutter test` mặc định không chạy goldens
- muốn verify goldens phải set `RUN_GOLDENS=true`
- README của golden infra ghi rõ hiện có một số baseline screen đang drift và failure artifact được ghi vào `test/goldens/failures/`

## 13. Ranh giới của app với API, server, và firmware

Kiến trúc app hiện tại có ba boundary chính:

### 13.1 Với cloud API

App dùng cloud API cho:

- auth
- homes/rooms
- device registration và rename
- device list, shadow, commands, telemetry history
- announce polling
- notification history

### 13.2 Với realtime server path

App dùng SSE `/realtime` do API sở hữu để nhận:

- `device.status`
- `shadow.reported`
- `command.updated`
- `telemetry.point`
- `ota.progress`
- `replay.reset`

App hiện không subscribe MQTT trực tiếp. MQTT nằm sau ranh giới server/API.

### 13.3 Với firmware runtime

App chỉ nói chuyện trực tiếp với firmware trong provisioning path:

- BLE GATT để gửi Wi-Fi credentials
- HTTP cục bộ `http://<device-ip>/api/info` và `/api/config` để trao MQTT credentials lần đầu

Sau khi thiết bị đã announce lên cloud, mọi tương tác vận hành bình thường quay lại mô hình app -> API -> server-owned realtime.
