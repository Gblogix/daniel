# GB Logix — 이 PC를 서버로 쓰기 (직원 + 고객 포털)

완성되면 직원과 고객이 어디서든 **https://app.gblogix.com** 으로 접속합니다.
공유기 포트는 열지 않습니다 — Cloudflare Tunnel이 안전하게 연결합니다 (무료).

---

## 0. 사양 확인 (5분)

1. `server-tools\check-specs.bat` 더블클릭 → 메모장에 결과가 뜹니다.
2. `[NO]` 줄이 없으면 OK. 결과를 그대로 복사해서 보내 주시면 같이 봐 드립니다.

---

## 1. 비밀번호부터 바꾸기 (인터넷에 열기 전에 꼭)

- Admin → Users: **admin 비밀번호 변경** (`changeme123` 그대로 두면 안 됩니다).
- 데모 계정(`demo1234`)은 모두 **비활성화**하거나 비밀번호 변경.
- 이 PC의 Windows 로그인 비밀번호 설정, 가능하면 **BitLocker** 켜기 (설정 → 개인정보 및 보안 → 장치 암호화).

## 2. `.env` 파일 설정 (start-windows.bat 옆)

```
BASE_URL=https://app.gblogix.com
SESSION_SECRET=여기에-아무-긴-문자열-40자-이상-예:gbl-7Kq2...
BACKUP_DIR=C:\Users\(사용자이름)\OneDrive\GB Logix Backup
```

- `SESSION_SECRET` : 아무 긴 문자열(영문·숫자 섞어 40자 이상). 바꾸면 모두 다시 로그인합니다.
- `BACKUP_DIR` : OneDrive 안의 폴더 → 매일 밤 DB와 서류가 복사되고 OneDrive로 PC 밖에도 저장됩니다.
  Admin → Automation 화면 **Backup** 칸에서 마지막 백업 시각을 확인하고 "Back up now"로 바로 테스트하세요.

## 3. 서버로 등록 (한 번만)

1. `server-tools\install-server.bat` → **마우스 오른쪽 → 관리자 권한으로 실행**.
2. Windows 로그인 **비밀번호**를 한 번 묻습니다 (PIN 아님). 그래야 아무도 로그인하지 않아도 PC가 켜지면 시스템이 시작됩니다.
3. 자동으로 설정되는 것:
   - 전원 연결 시 절전·최대 절전 **안 함**, 노트북 **덮개를 닫아도 계속 켜짐**
   - 부팅하면 자동 시작, 멈추면 10초 뒤 자동 재시작
   - 기록: `logs\server.log`
4. 확인: PC를 재시작한 뒤 로그인하지 말고 다른 PC/폰에서 (4번까지 끝낸 후) 접속해 보기.

| 할 일 | 파일 (관리자 권한으로 실행) |
|---|---|
| 업데이트 후 (ZIP을 같은 폴더에 덮어쓰기) | `server-tools\restart-server.bat` |
| 서버 해제 (데이터는 그대로) | `server-tools\uninstall-server.bat` |

> ZIP 업데이트는 **같은 폴더에 덮어쓰기** 하세요. `data`, `uploads`, `.env`는 ZIP에 없으므로 그대로 남습니다.

## 4. 밖에서 접속: GoDaddy 도메인 → Cloudflare Tunnel

### 4-1. Cloudflare에 도메인 추가 (이메일 설정 확인이 핵심)
1. https://dash.cloudflare.com 무료 가입 → **Add a domain** → `gblogix.com` → **Free** 플랜.
2. Cloudflare가 기존 DNS 기록을 자동으로 가져옵니다. **GoDaddy DNS 화면과 비교해서 아래가 모두 있는지 확인**:
   - **MX** (Outlook 이메일, 보통 `gblogix-com.mail.protection.outlook.com`)
   - **TXT** (`v=spf1 include:spf.protection.outlook.com …`, 도메인 인증 TXT)
   - **CNAME** `autodiscover`, 웹사이트용 **A / CNAME** (`@`, `www`)
   - 빠진 게 있으면 GoDaddy에서 보고 똑같이 추가. 이메일 관련 기록은 **회색 구름(DNS only)** 으로.
3. Cloudflare가 **네임서버 2개**를 알려 줍니다 (예: `xxx.ns.cloudflare.com`).

### 4-2. GoDaddy에서 네임서버 변경
1. GoDaddy 로그인 → **My Products** → gblogix.com 옆 **DNS** → **Nameservers** → **Change Nameservers**.
2. **"I'll use my own nameservers"** → Cloudflare 네임서버 2개 입력 → 저장.
3. 보통 1시간 안에(최대 24시간) Cloudflare에서 "Active" 메일이 옵니다. 이메일은 그대로 계속 됩니다.

### 4-3. 터널 만들기 (서버 PC에서)
1. Cloudflare → **Zero Trust** (처음이면 팀 이름 정하고 Free 플랜) → **Networks → Tunnels → Create a tunnel** → **Cloudflared** → 이름 `gblogix-server`.
2. **Windows** 선택 → 안내대로 **cloudflared 설치 파일** 다운로드·설치 →
   화면에 나오는 명령 `cloudflared.exe service install eyJ…` 를 **관리자 PowerShell**에 붙여넣기 → 상태가 **Healthy** 가 되면 OK.
3. **Public Hostname** 추가: Subdomain `app`, Domain `gblogix.com`, Service **HTTP** `localhost:3000` → 저장.
4. 폰 Wi-Fi를 끄고 `https://app.gblogix.com` 접속 → 로그인 화면이 나오면 성공.

### 4-4. 고객에게 안내
- Admin → Users에서 고객 계정 초대 → 고객은 `https://app.gblogix.com` 에서 자기 화물만 봅니다.
- 고객별로 숨길 항목(Empty return 등)은 Parties → 고객 편집 → "Hide on the customer portal".

## 5. 평소 관리

- 노트북이면: **항상 전원 연결**, 단단한 곳에(통풍), 화면 덮개는 닫아도 됩니다.
- Windows 업데이트로 재부팅돼도 자동으로 다시 켜집니다.
- 주 1회: Admin → Automation → **Backup** 시각 확인. 월 1회: OneDrive 백업 폴더에 날짜별 파일이 쌓이는지 확인.
- 문제가 생기면 `logs\server.log` 파일을 보내 주세요.
