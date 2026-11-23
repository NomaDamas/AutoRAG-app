# Modal copy

How the app's modals and dialogs speak. Every new modal follows this, and a
change to an existing one brings it in line. The Korean text is the reference;
English, Japanese, and Simplified Chinese say the same thing in each language's
own idiom (see `AGENTS.md` "User-facing text and translations").

## Tone

- Korean is written in the **~합니다** style: 삭제됩니다, 입력하세요,
  필요합니다. Not ~해요, not ~해 주세요.
- Never blame the person: 형식을 확인하세요, not 잘못 입력했습니다.
- Error codes and raw technical output do not go in the body. Show them
  separately, under a details control or in the error box.

## Anatomy

| Part | Rule |
| --- | --- |
| Title | One line, no period. A question (`~할까요?`) when the modal asks for a decision. A statement (`~했습니다`, `~하지 못했습니다`, `~이 필요합니다`) when it reports a state. A noun phrase (`검색 폴더 추가`) when it takes input or runs a task. |
| Body | At most two sentences: what happens, then what stays (or what the person can do). Do not repeat the title, and do not end with 정말 ~하시겠습니까? |
| Buttons | Named after the action (`삭제`, `연결 해제`, `다시 시도`). `확인` only when there is nothing else to do. The safe choice comes first; a destructive action is red. |
| Quotes | `‘ ’` around a name in Korean (`‘{{name}}’`). Japanese uses `「」`, Chinese `“”`, and English `‘ ’`. |

**The same action has the same name everywhere:**

- `연결 해제`, not `연결 끊기`
- `백그라운드로 전환`, not `백그라운드에서 계속`
- `중단` for stopping work that is running

## Patterns

Each pattern has one reference modal. Write a new modal from its pattern's
reference.

### A. Confirm before something that is hard to undo

Reference: deleting an automation rule (`automations.confirm.*`).

| | |
| --- | --- |
| Title | ‘{{title}}’ 규칙을 삭제할까요? |
| Body | 이 규칙만 삭제되고 폴더와 파일은 그대로 유지됩니다. |
| Buttons | 취소 · **삭제** (red) |

Say what is removed and what is kept. If nothing can bring it back, say
`이 작업은 되돌릴 수 없습니다.`

### B. Confirm stopping work that is running

Reference: stopping a compression (`confirm.compressStop*`).

| | |
| --- | --- |
| Title | 압축을 중단할까요? |
| Body | 지금까지 만든 압축 파일은 삭제됩니다. |
| Buttons | 계속 압축 · **중단** |

The keep-going button names the work (`계속 압축`).

### C. Ask for input

Reference: adding a search folder (`settingsSources.scope.addFolder*`).

| | |
| --- | --- |
| Title | 검색 폴더 추가 |
| Body | 검색에 포함할 폴더 경로를 입력하세요. |
| Buttons | 취소 · **추가** |

The body is an instruction (`~을 입력하세요`). A second sentence may say what
an empty field means.

### D. Pick options, then run

Reference: converting a file (`finder.convert.*`).

| | |
| --- | --- |
| Title | 다른 형식으로 변환 |
| Body | ‘{{name}}’을(를) ‘{{newName}}’(으)로 변환합니다. 원본은 어떻게 할까요? |
| Buttons | 취소 · 원본 유지 · **원본 덮어쓰기** |
| While running | 변환하는 중… · `백그라운드로 전환` |

### E. Ask for a permission

Reference: the microphone (`aiSearch.micPermission.*`).

| | |
| --- | --- |
| Title | 마이크 권한이 필요합니다 |
| Body | 음성으로 물어보려면 Dazzi에 마이크 권한이 필요합니다. 녹음은 마이크 버튼을 누를 때만 합니다. |
| Steps | 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 Dazzi를 켜세요. |
| Buttons | 나중에 · **시스템 설정 열기** |

Say why the permission is needed and what Dazzi will and will not do with it.

### F. Report a result or a failure

Reference: AI fix (`appError.fix.*`).

| | |
| --- | --- |
| Title | 문제를 해결하지 못했습니다 |
| Body | 원인을 찾지 못했습니다. 오류 내용을 확인하세요. |
| Buttons | 닫기 · **다시 시도** |

Titles are sentences: `~했습니다` when the work succeeded, and
`~하지 못했습니다` when it failed (not 실패, not ~되었습니다).
