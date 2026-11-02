# Dazzi mobile remote access prototype

A phone-width layout for the remote browser session (`src/main/remote/`). Today
that session serves the desktop renderer unchanged: `src/renderer/index.html`
has no viewport meta, no stylesheet has a phone breakpoint, and the layout is
built for `--app-min-width: 1360px`, so a phone shows a shrunken three-pane
Finder. This prototype redesigns that surface from scratch around iOS 26
patterns while keeping the desktop's features and the same `window.autorag`
calls.

Onboarding is not redesigned: a remote session only exists after the desktop
app is set up.

## Open it

```sh
python3 -m http.server 47900 --bind 127.0.0.1     # from the repo root
open http://127.0.0.1:47900/docs/prototypes/mobile-remote/index.html
```

On a desktop browser it draws a phone frame with a scene list on the left
(`#<scene name>` links to a scene, `?theme=dark` starts in dark mode). In a
window 500px wide or less, including a real phone on the same network, it fills
the screen the way the remote session would.

`node docs/prototypes/mobile-remote/shoot.mjs <outDir> [scene …] [--dark]`
screenshots every scene at 393 × 852 with touch enabled and fails on any page
error. `node docs/prototypes/mobile-remote/gen-icons.mjs` regenerates
`icons.js` from the pinned `lucide-react`.

## References

- iOS Files on iPhone: Browse as a grouped list of Favorites / Locations / Tags,
  folders pushed full screen, a long-press menu with a Copy · Move · Share strip
  on top ([AppleInsider, iPadOS 26 Files guide](https://appleinsider.com/inside/ipados-26/tips/inside-files---how-to-manage-files-like-a-pro-on-iphone-ipad-and-apple-vision-pro)).
- HIG [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars):
  the bar floats on Liquid Glass, a search tab sits at the trailing end, the bar
  can minimize on scroll with an accessory (Music's mini player) moving inline.
- HIG [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets):
  medium and large detents, a grabber, swipe to dismiss, Cancel leading and Done
  trailing.
- WWDC25 [Build a UIKit app with the new design](https://developer.apple.com/videos/play/wwdc2025/284):
  transparent bars with grouped glass buttons, the scroll edge effect, the
  prominent tinted Done, menus that grow out of their source button, search in
  the bottom toolbar on iPhone.

## How the desktop maps to the phone

| Desktop | Phone |
|---|---|
| Sidebar (즐겨찾기, 연결, 위치, 태그) | 둘러보기 tab: grouped inset lists, collapsible sections, drive capacity bars |
| AI 검색, 자동화 sidebar rows | Their own tabs (they were always pinned first and could not be hidden) |
| 최근 항목 | Its own tab, grouped by day with kind filters |
| Sidebar search (파일 이름 / 내용) | Search tab at the trailing end of the bar; 파일 이름 lists matches, 내용 hands the query to AI 검색 |
| Tabs, split panes | Per-tab navigation stacks; back button and edge swipe instead of a tab strip |
| Toolbar view modes, 정렬, 그룹 | ⋯ menu: 아이콘 / 목록, sort key with direction; the sort chip under the title |
| Path bar | Tapping the title (⌄) lists every ancestor to jump to, plus 경로 복사 |
| Inspector (정보) | 정보 sheet: preview tile, four quick actions, AI 검색에 포함 switch, suggested actions, dupey versions, metadata |
| Inspector (근거) | 근거 sheet from a citation chip or source card |
| Right-click menu | Long-press, the trailing ⋯, or right-click: quick strip (복사 · 이동 · 다운로드), then 훑어보기/정보, AI 요약 + 매직 액션, a 빠른 작업 submenu (압축, 변환, 용량 줄이기, 인덱싱, 복제), 이름 변경, 경로 복사, tag dots, 휴지통 |
| ⌘/⇧ multi-select, marquee | ⋯ → 선택; checkmarks; a toolbar replaces the tab bar (이동, 복사, AI에게, 더보기, 휴지통) |
| Drag to move | 이동 / 복사 destination sheet with breadcrumbs and 새 폴더 |
| Drop files in | ＋ → 이 기기에서 올리기 (`autorag.fs.uploadFiles` already exists for remote) |
| Drag out | 다운로드 (the remote server already turns drag-out into a download) |
| Inline rename | Alert with the name stem preselected; collision reported in place |
| Undo stack (⌘Z) | Every file change toasts with 실행 취소 |
| Quick Look window | Full-screen viewer: swipe between siblings, tap to hide chrome, pull down to close |
| Sidebar activity queue | Accessory above the tab bar (ring + headline + `+N`), tap for the 진행 및 대기열 sheet |
| Approval dock | Glass card that replaces the composer until answered; red badge on the AI 검색 tab when another tab is open |
| Settings | Account card from the avatar; only settings that make sense on a phone, the rest named as desktop-only |

## Decisions

- **One primary action per gesture.** Tap opens, long-press menus, left swipe
  shows 휴지통 · 더보기, and every row also has a visible ⋯ so nothing depends on
  a hidden gesture.
- **The menu never scrolls.** Desktop has 20+ context-menu items; on a phone the
  verbs used most go into the quick strip and the rest fold into 매직 액션 and
  빠른 작업 submenus, so the whole menu fits under the lifted row. When the row is
  low on screen the row slides up, as iOS does, instead of squeezing the menu.
- **Middle truncation keeps extensions** (`ktwiz 캡틴 박경수 응원가 l…가 부활.mp3`),
  since many names in a real tree differ only at the end.
- **AI 검색 is reachable from every item**: menu, info sheet, selection toolbar,
  folder chip, and a search query; the attachment then shows in the composer.
- **No action a phone cannot complete.** 다른 앱으로 열기, Finder에서 보기, 서비스,
  이미지 편집 and 공유 to desktop apps are absent rather than disabled, matching
  `REMOTE_NATIVE_ONLY_METHODS`. Files with no browser preview (HWP, DOCX, PPTX)
  show a 다운로드 card in 훑어보기, as `REMOTE_PREVIEW_MIMES` dictates.
- **Glass only on the control layer** (bars, menus, accessory, composer);
  content stays on plain or grouped backgrounds, per the WWDC25 guidance.
- **Brand tokens where the app has them** (`--accent`, `--folder`, tag and
  status colors, Pretendard); iOS system surfaces are the `--m-*` values in
  `prototype.css`.

## What the build needs (not in this prototype)

- `src/renderer/index.html` needs `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`;
  the remote `static.ts` rewrite could inject it for remote sessions only.
- A phone shell chosen at startup when `globalThis.autoragIsRemote` and the
  viewport is narrow, reusing the existing state modules and `window.autorag`;
  the desktop shell stays unchanged.
- Conversions and 용량 줄이기 call `conversion.*` / `actions.run`, which are
  `REMOTE_NATIVE_ONLY_METHODS` today. They run on the host, so they could be
  allowed remotely; until then the phone build must hide them.
- Upload is not undoable (`settingsCore.general.remoteLimitations`), so the
  real upload toast must not offer 실행 취소.
- Every string here is Korean demo copy; the real screens go through i18next in
  all four locales.
