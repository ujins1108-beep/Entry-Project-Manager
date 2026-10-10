(() => {
  "use strict";

  const ROOT_ID = "entry-project-visibility-manager";
  const PAGE_SIZE = 100;
  const MAX_PROJECTS = 10000;
  const EXCLUDED_PROJECTS_STORAGE_PREFIX = "entryProjectManagerExcluded:";
  const SELECT_PROJECTS = `
    query SELECT_USER_PROJECTS(
      $user: String!
      $pageParam: PageParam
      $isOpen: String
      $term: String
    ) {
      userProjectList(
        user: $user
        pageParam: $pageParam
        isOpen: $isOpen
        term: $term
      ) {
        total
        list {
          id
          name
          isopen
          likeCnt
          comment
          staffPicked
          ranked
        }
      }
    }
  `;
  let activeUserId = null;
  let isRunning = false;
  let openManagerFromExtension = null;
  let openMainMenuFromExtension = null;
  let openStatsFromExtension = null;

  function toggleWithPageAuthentication(projectId) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(
          new Error(
            "엔트리 인증 요청 응답이 없습니다. 페이지를 새로고침하고 다시 시도해 주세요.",
          ),
        );
      }, 15000);

      function onMessage(event) {
        const message = event.data;
        if (
          event.source !== window ||
          event.origin !== window.location.origin ||
          message?.channel !== "entry-project-manager-auth-bridge" ||
          message.type !== "TOGGLE_PROJECT_RESULT" ||
          message.requestId !== requestId
        ) {
          return;
        }

        window.clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        if (!message.ok) {
          reject(new Error(message.error || "엔트리에서 상태 변경을 거부했습니다."));
          return;
        }
        resolve(message.data);
      }

      window.addEventListener("message", onMessage);
      window.postMessage(
        {
          channel: "entry-project-manager-auth-bridge",
          type: "TOGGLE_PROJECT",
          requestId,
          projectId,
        },
        window.location.origin,
      );
    });
  }

  function getPageUserId() {
    const match = window.location.pathname.match(/^\/profile\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function isSignedIn() {
    const loginLinks = document.querySelectorAll(
      'a[href="/signin"], a[href^="/signin?"], a[href^="/signin/"]',
    );
    return loginLinks.length === 0;
  }

  function graphql(operationName, query, variables) {
    if (operationName === "TOGGLE_ISOPEN_PROJECT") {
      return toggleWithPageAuthentication(variables.id);
    }

    const headers = {
      "Content-Type": "application/json",
      "X-Client-Type": "Client",
    };
    const csrfToken = document
      .querySelector('meta[name="csrf-token"]')
      ?.getAttribute("content");
    if (csrfToken) headers["CSRF-Token"] = csrfToken;

    return fetch(`https://playentry.org/graphql/${operationName}`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ operationName, query, variables }),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`엔트리 요청 실패 (HTTP ${response.status})`);
      }
      const payload = await response.json();
      if (payload.errors?.length) {
        throw new Error(payload.errors.map((error) => error.message).join("\n"));
      }
      return payload.data;
    });
  }

  async function fetchAllProjects(userId) {
    const projects = [];
    const seenIds = new Set();
    let total = null;

    let start = 0;
    while (total === null || start < total) {
      if (start >= MAX_PROJECTS) {
        throw new Error(
          `작품이 ${MAX_PROJECTS.toLocaleString()}개를 넘어 안전하게 전체 목록을 확인할 수 없습니다.`,
        );
      }

      const data = await graphql("SELECT_USER_PROJECTS", SELECT_PROJECTS, {
        user: userId,
        pageParam: { display: PAGE_SIZE, sort: "created", start, order: "desc" },
        isOpen: "all",
        term: "all",
      });
      const page = data?.userProjectList;
      if (!page || !Array.isArray(page.list) || !Number.isFinite(page.total)) {
        throw new Error("엔트리에서 작품 목록을 올바르게 받지 못했습니다.");
      }
      if (total === null) total = page.total;
      if (page.total !== total) {
        throw new Error("작품 목록을 불러오는 중 전체 작품 수가 변경되었습니다. 다시 시도해 주세요.");
      }

      const previousProjectCount = projects.length;
      for (const project of page.list) {
        if (project?.id && !seenIds.has(project.id)) {
          seenIds.add(project.id);
          projects.push({
            id: project.id,
            name: project.name || "이름 없는 작품",
            isopen: Boolean(project.isopen),
            likeCnt: Number.isFinite(project.likeCnt) ? project.likeCnt : 0,
            comment: Number.isFinite(project.comment) ? project.comment : 0,
            staffPicked: Boolean(project.staffPicked),
            ranked: Boolean(project.ranked),
          });
        }
      }

      if (
        page.list.length === 0 ||
        projects.length === previousProjectCount
      ) {
        throw new Error("작품 목록 일부를 불러오지 못해 변경을 중단했습니다.");
      }
      start += page.list.length;
    }

    if (projects.length !== total) {
      throw new Error(
        `전체 작품 ${total}개 중 ${projects.length}개만 확인되어 변경을 중단했습니다.`,
      );
    }
    return projects;
  }

  async function toggleProject(project) {
    const data = await graphql("TOGGLE_ISOPEN_PROJECT", "", { id: project.id });
    const result = data?.toggleIsopenProject;
    const status = result?.status;
    if (
      !result ||
      result.result === false ||
      (status !== 0 &&
        status !== "0" &&
        status !== 200 &&
        status !== "200")
    ) {
      throw new Error(
        `"${project.name}" 작품 변경 실패 (엔트리 응답 코드: ${status ?? "없음"}).`,
      );
    }
  }

  function addStyles() {
    if (document.getElementById(`${ROOT_ID}-styles`)) return;
    const style = document.createElement("style");
    style.id = `${ROOT_ID}-styles`;
    style.textContent = `
      #${ROOT_ID} {
        --epm-bg:#f3f5f8;
        --epm-card:#fff;
        --epm-text:#252d39;
        --epm-muted:#7b8491;
        --epm-line:#d8dfe8;
        --epm-navy:#172e56;
        --epm-blue:#254b83;
        --epm-blue-bright:#347ed8;
        --epm-purple:#6957e8;
        --epm-teal:#17a797;
        --epm-green:#21c49a;
        color:var(--epm-text);
        font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      #${ROOT_ID} * { box-sizing:border-box; }
      #${ROOT_ID} button { font:inherit; cursor:pointer; }
      #${ROOT_ID} button:focus-visible,
      #${ROOT_ID} a:focus-visible,
      #${ROOT_ID} input:focus-visible {
        outline:3px solid #66a6ff;
        outline-offset:2px;
      }
      #${ROOT_ID} .epm-launcher {
        position:fixed;
        right:22px;
        bottom:22px;
        z-index:2147483646;
        padding:12px 20px;
        border:1px solid #ffffff40;
        border-radius:999px;
        color:#fff;
        background:linear-gradient(110deg,var(--epm-navy),var(--epm-blue));
        box-shadow:0 7px 20px #172e5638;
        font-size:15px;
        font-weight:800;
        transition:transform .15s ease, box-shadow .15s ease;
      }
      #${ROOT_ID} .epm-launcher:hover {
        transform:translateY(-2px);
        box-shadow:0 10px 24px #172e5645;
      }
      #${ROOT_ID} .epm-backdrop {
        position:fixed;
        inset:0;
        z-index:2147483647;
        display:grid;
        place-items:center;
        padding:18px;
        background:#101a2cb8;
        backdrop-filter:blur(3px);
      }
      #${ROOT_ID} .epm-backdrop[hidden] { display:none; }
      #${ROOT_ID} .epm-menu-backdrop {
        position:fixed;
        inset:0;
        z-index:2147483647;
        display:grid;
        place-items:center;
        padding:18px;
        background:#101a2cb8;
        backdrop-filter:blur(3px);
      }
      #${ROOT_ID} .epm-menu-backdrop[hidden] { display:none; }
      #${ROOT_ID} .epm-menu-modal {
        display:flex;
        width:min(560px,100%);
        flex-direction:column;
        overflow:hidden;
        border:1px solid #d5dce6;
        border-radius:18px;
        background:var(--epm-bg);
        box-shadow:0 24px 75px #08132655;
      }
      #${ROOT_ID} .epm-menu-body { padding:22px; }
      #${ROOT_ID} .epm-menu-intro {
        margin:0 0 20px;
        color:var(--epm-muted);
        font-size:15px;
      }
      #${ROOT_ID} .epm-menu-label {
        margin:0 0 11px 2px;
        color:var(--epm-muted);
        font-size:13px;
        font-weight:750;
      }
      #${ROOT_ID} .epm-menu-options { display:grid; gap:12px; }
      #${ROOT_ID} .epm-menu-option {
        display:flex;
        min-height:76px;
        align-items:center;
        justify-content:space-between;
        gap:14px;
        padding:14px 17px;
        border:1px solid #ffffff40;
        border-radius:15px;
        color:#fff;
        background:linear-gradient(110deg,var(--epm-navy),var(--epm-blue));
        box-shadow:0 6px 15px #172e5624;
        text-align:left;
        transition:filter .15s ease, transform .15s ease, box-shadow .15s ease;
      }
      #${ROOT_ID} .epm-menu-option:hover {
        filter:brightness(1.07);
        transform:translateY(-1px);
        box-shadow:0 9px 20px #172e5630;
      }
      #${ROOT_ID} .epm-menu-option[data-menu="stats"] {
        background:linear-gradient(110deg,#11877f,#20a99e);
        box-shadow:0 6px 15px #17a79724;
      }
      #${ROOT_ID} .epm-menu-option-copy { display:grid; gap:3px; }
      #${ROOT_ID} .epm-menu-option-title { font-size:17px; font-weight:800; }
      #${ROOT_ID} .epm-menu-option-description { color:#dbe4f0; font-size:13px; font-weight:500; }
      #${ROOT_ID} .epm-menu-option[data-menu="stats"] .epm-menu-option-description { color:#d9f2ef; }
      #${ROOT_ID} .epm-menu-option-arrow {
        display:grid;
        width:34px;
        height:34px;
        flex:0 0 34px;
        place-items:center;
        border:1px solid #ffffff40;
        border-radius:50%;
        background:#ffffff18;
        font-size:25px;
        line-height:1;
      }
      #${ROOT_ID} .epm-menu-footer {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        margin-top:18px;
        padding-top:14px;
        border-top:1px solid var(--epm-line);
        color:var(--epm-muted);
        font-size:12px;
      }
      #${ROOT_ID} .epm-menu-close {
        padding:7px 13px;
        border:0;
        border-radius:999px;
        color:var(--epm-text);
        background:var(--epm-line);
        font-weight:700;
      }
      #${ROOT_ID} .epm-modal {
        display:flex;
        width:min(720px,100%);
        max-height:min(900px,calc(100vh - 36px));
        flex-direction:column;
        overflow:hidden;
        border:1px solid #d5dce6;
        border-radius:18px;
        background:var(--epm-bg);
        box-shadow:0 24px 75px #08132655;
      }
      #${ROOT_ID} .epm-header {
        display:flex;
        min-height:68px;
        align-items:center;
        gap:14px;
        padding:12px 18px;
        color:#fff;
        background:linear-gradient(110deg,#14284b,#203d70);
      }
      #${ROOT_ID} .epm-logo {
        display:block;
        width:40px;
        height:40px;
        flex:0 0 40px;
        border:1px solid #ffffff28;
        border-radius:11px;
        object-fit:cover;
      }
      #${ROOT_ID} .epm-title {
        flex:1;
        margin:0;
        color:#fff;
        font-size:clamp(16px,3.4vw,23px);
        font-weight:800;
        letter-spacing:-.35px;
        text-align:center;
      }
      #${ROOT_ID} .epm-body {
        overflow:auto;
        padding:18px 20px 20px;
        scrollbar-color:#aeb9c7 transparent;
        scrollbar-width:thin;
      }
      #${ROOT_ID} .epm-stats {
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:18px;
        padding:0 0 18px;
      }
      #${ROOT_ID} .epm-stats-summary {
        margin:0 0 14px;
        padding:12px 14px;
        border:1px solid var(--epm-line);
        border-radius:11px;
        color:var(--epm-muted);
        background:var(--epm-card);
        text-align:center;
      }
      #${ROOT_ID} .epm-stats-summary strong { color:var(--epm-text); }
      #${ROOT_ID} .epm-stats-result {
        min-height:26px;
        margin:0 0 12px;
        color:var(--epm-muted);
        font-size:13px;
        text-align:center;
      }
      #${ROOT_ID} .epm-stats-result[data-kind="error"] { color:#c83232; }
      #${ROOT_ID} .epm-stats-actions {
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:10px;
      }
      #${ROOT_ID} .epm-stat-section { margin-top:18px; }
      #${ROOT_ID} .epm-stat-section-heading {
        margin:0 0 10px;
        font-size:clamp(16px,3vw,19px);
        font-weight:800;
      }
      #${ROOT_ID} .epm-stat-cards {
        display:grid;
        grid-template-columns:repeat(2,minmax(0,1fr));
        gap:10px;
      }
      #${ROOT_ID} .epm-stat-cards[data-columns="3"] {
        grid-template-columns:repeat(3,minmax(0,1fr));
      }
      #${ROOT_ID} .epm-stat-card {
        display:flex;
        min-width:0;
        min-height:82px;
        flex-direction:column;
        justify-content:center;
        gap:5px;
        padding:12px;
        border:1px solid var(--epm-line);
        border-radius:12px;
        background:var(--epm-card);
        text-align:center;
      }
      #${ROOT_ID} .epm-stat-card-label {
        color:var(--epm-muted);
        font-size:13px;
        font-weight:700;
      }
      #${ROOT_ID} .epm-stat-card-value {
        color:var(--epm-text);
        font-size:clamp(20px,4vw,27px);
        font-weight:850;
        font-variant-numeric:tabular-nums;
        line-height:1.2;
      }
      #${ROOT_ID} .epm-stat-card-note {
        color:var(--epm-muted);
        font-size:11px;
        line-height:1.4;
      }
      #${ROOT_ID} .epm-top-project {
        padding:14px 16px;
        border:1px solid var(--epm-line);
        border-radius:12px;
        background:var(--epm-card);
      }
      #${ROOT_ID} .epm-top-project-name {
        margin:0;
        color:var(--epm-blue);
        font-size:16px;
        font-weight:800;
        overflow-wrap:anywhere;
      }
      #${ROOT_ID} .epm-top-project-summary {
        margin:7px 0 0;
        color:var(--epm-muted);
        font-size:13px;
      }
      #${ROOT_ID} .epm-stat { min-width:0; text-align:center; }
      #${ROOT_ID} .epm-stat-title {
        margin:0 0 10px;
        font-size:clamp(17px,3vw,21px);
        font-weight:800;
        letter-spacing:-.2px;
      }
      #${ROOT_ID} .epm-stat-title[data-mode="private"] { color:#233e71; }
      #${ROOT_ID} .epm-stat-title[data-mode="public"] { color:#087f78; }
      #${ROOT_ID} .epm-ring {
        display:grid;
        width:min(100%,218px);
        aspect-ratio:1;
        margin:auto;
        place-items:center;
        border:10px solid #202326;
        border-radius:50%;
        background:conic-gradient(from -90deg,var(--ring-color) var(--ring-value,0%),#44484c 0);
        box-shadow:0 4px 10px #10182020;
      }
      #${ROOT_ID} .epm-ring-inner {
        display:flex;
        width:calc(100% - 5px);
        height:calc(100% - 5px);
        flex-direction:column;
        align-items:center;
        justify-content:center;
        border:9px solid #313437;
        border-radius:50%;
        color:#f3f4f6;
        background:#1d1f21;
      }
      #${ROOT_ID} .epm-ring-label { color:#c2c6ca; font-size:15px; }
      #${ROOT_ID} .epm-ring-count {
        margin:0;
        font-size:clamp(34px,8vw,50px);
        font-weight:850;
        line-height:1.16;
        font-variant-numeric:tabular-nums;
      }
      #${ROOT_ID} .epm-ring-total { color:#bbc0c5; font-size:14px; }
      #${ROOT_ID} .epm-excluded,
      #${ROOT_ID} .epm-log {
        overflow:hidden;
        border:1px solid var(--epm-line);
        border-radius:13px;
        background:var(--epm-card);
        box-shadow:0 2px 7px #14284b08;
      }
      #${ROOT_ID} .epm-excluded { margin-top:2px; padding:13px 14px; }
      #${ROOT_ID} .epm-excluded-heading {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
        margin:0 0 5px;
        font-size:16px;
        font-weight:800;
      }
      #${ROOT_ID} [data-excluded-count] {
        display:inline-grid;
        min-width:28px;
        height:25px;
        place-items:center;
        padding:0 7px;
        border-radius:999px;
        color:#fff;
        background:var(--epm-navy);
        font-size:13px;
      }
      #${ROOT_ID} .epm-excluded-help {
        margin:0 0 10px;
        color:var(--epm-muted);
        font-size:12px;
      }
      #${ROOT_ID} .epm-excluded-form { display:flex; gap:8px; }
      #${ROOT_ID} .epm-excluded-input {
        min-width:0;
        min-height:42px;
        flex:1;
        padding:9px 12px;
        border:1px solid var(--epm-line);
        border-radius:9px;
        color:var(--epm-text);
        background:var(--epm-bg);
        font:inherit;
        font-size:13px;
      }
      #${ROOT_ID} .epm-excluded-submit,
      #${ROOT_ID} .epm-excluded-item button {
        padding:8px 13px;
        border:0;
        border-radius:9px;
        color:#fff;
        background:linear-gradient(110deg,var(--epm-navy),var(--epm-blue));
        font-weight:750;
        white-space:nowrap;
        transition:filter .15s ease, transform .15s ease;
      }
      #${ROOT_ID} .epm-excluded-submit:hover:not(:disabled),
      #${ROOT_ID} .epm-excluded-item button:hover:not(:disabled) {
        filter:brightness(1.08);
        transform:translateY(-1px);
      }
      #${ROOT_ID} .epm-excluded-submit:disabled,
      #${ROOT_ID} .epm-excluded-item button:disabled { cursor:wait; opacity:.55; }
      #${ROOT_ID} .epm-excluded-message {
        min-height:1.3em;
        margin:6px 0 0;
        color:var(--epm-muted);
        font-size:12px;
        overflow-wrap:anywhere;
      }
      #${ROOT_ID} .epm-excluded-message[data-kind="error"],
      #${ROOT_ID} .epm-log-item[data-kind="error"] { color:#c83232; }
      #${ROOT_ID} .epm-excluded-message[data-kind="success"] { color:#087f78; }
      #${ROOT_ID} .epm-excluded-list {
        display:grid;
        max-height:110px;
        gap:6px;
        margin:8px 0 0;
        padding:0;
        overflow:auto;
        list-style:none;
      }
      #${ROOT_ID} .epm-excluded-item {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
        padding:7px 0 0;
        border-top:1px solid var(--epm-line);
      }
      #${ROOT_ID} .epm-excluded-item a {
        min-width:0;
        overflow:hidden;
        color:var(--epm-blue);
        font-weight:650;
        text-overflow:ellipsis;
        white-space:nowrap;
      }
      #${ROOT_ID} .epm-excluded-item button {
        padding:6px 10px;
        color:var(--epm-text);
        background:var(--epm-bg);
        box-shadow:inset 0 0 0 1px var(--epm-line);
        font-size:12px;
      }
      #${ROOT_ID} .epm-excluded-empty { color:var(--epm-muted); font-size:13px; }
      #${ROOT_ID} .epm-result {
        padding:16px 0 14px;
        border-top:1px solid var(--epm-line);
      }
      #${ROOT_ID} .epm-result-heading {
        display:flex;
        align-items:center;
        gap:10px;
        margin:0 0 10px;
        font-size:clamp(17px,3.5vw,22px);
        font-weight:800;
        letter-spacing:-.25px;
      }
      #${ROOT_ID} .epm-result-icon {
        display:grid;
        width:32px;
        height:32px;
        flex:0 0 32px;
        place-items:center;
        border:1px solid #ffffff30;
        border-radius:50%;
        color:#fff;
        background:#101418;
        font-size:18px;
      }
      #${ROOT_ID} .epm-progress-row { display:flex; align-items:center; gap:10px; }
      #${ROOT_ID} .epm-progress-track {
        height:14px;
        flex:1;
        overflow:hidden;
        border:1px solid #9acbbb;
        border-radius:99px;
        background:#dce9e5;
      }
      #${ROOT_ID} .epm-progress {
        width:0;
        height:100%;
        border-radius:inherit;
        background:linear-gradient(90deg,#20a783,#25c9a5);
        transition:width .24s ease;
      }
      #${ROOT_ID} .epm-percent {
        min-width:44px;
        color:var(--epm-text);
        text-align:right;
        font-variant-numeric:tabular-nums;
      }
      #${ROOT_ID} .epm-log { margin-top:14px; }
      #${ROOT_ID} .epm-log-title {
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:9px 13px;
        border-bottom:1px solid var(--epm-line);
        font-weight:800;
      }
      #${ROOT_ID} .epm-refresh {
        padding:4px 8px;
        border:0;
        border-radius:7px;
        color:var(--epm-muted);
        background:transparent;
        font-size:13px;
        font-weight:700;
      }
      #${ROOT_ID} .epm-refresh:hover:not(:disabled) { color:var(--epm-blue); background:var(--epm-bg); }
      #${ROOT_ID} .epm-refresh:disabled { cursor:wait; opacity:.5; }
      #${ROOT_ID} .epm-log-list {
        max-height:138px;
        margin:0;
        padding:9px 13px;
        overflow:auto;
        list-style:none;
      }
      #${ROOT_ID} .epm-log-item {
        display:flex;
        align-items:flex-start;
        gap:8px;
        padding:4px 0;
        color:var(--epm-text);
        overflow-wrap:anywhere;
      }
      #${ROOT_ID} .epm-log-mark {
        flex:0 0 18px;
        color:var(--epm-navy);
        font-weight:900;
        text-align:center;
      }
      #${ROOT_ID} .epm-log-item[data-kind="success"] .epm-log-mark { color:#11977f; }
      #${ROOT_ID} .epm-log-item[data-kind="info"] { color:var(--epm-muted); }
      #${ROOT_ID} .epm-actions {
        display:grid;
        grid-template-columns:1fr 1fr auto;
        gap:10px;
        padding-top:16px;
      }
      #${ROOT_ID} .epm-stats-actions .epm-action[data-mode="close"] { min-width:0; }
      #${ROOT_ID} .epm-action {
        min-height:48px;
        padding:9px 14px;
        border:0;
        border-radius:999px;
        color:#fff;
        background:linear-gradient(110deg,var(--epm-navy),var(--epm-blue));
        box-shadow:0 4px 10px #172e561c;
        font-weight:800;
        white-space:nowrap;
        transition:filter .15s ease, transform .15s ease, box-shadow .15s ease;
      }
      #${ROOT_ID} .epm-action:hover:not(:disabled) {
        filter:brightness(1.07);
        transform:translateY(-1px);
        box-shadow:0 6px 13px #172e5626;
      }
      #${ROOT_ID} .epm-action[data-mode="public"] {
        background:linear-gradient(110deg,#11877f,#20a99e);
        box-shadow:0 4px 10px #17a79724;
      }
      #${ROOT_ID} .epm-action[data-mode="close"] {
        min-width:78px;
        color:#3f4855;
        background:#e2e6eb;
        box-shadow:none;
      }
      #${ROOT_ID} .epm-action:disabled { cursor:wait; opacity:.55; }
      @media (max-width:520px) {
        #${ROOT_ID} .epm-backdrop,
        #${ROOT_ID} .epm-menu-backdrop { padding:8px; }
        #${ROOT_ID} .epm-modal { max-height:calc(100vh - 16px); border-radius:14px; }
        #${ROOT_ID} .epm-menu-modal { border-radius:14px; }
        #${ROOT_ID} .epm-menu-body { padding:16px 13px; }
        #${ROOT_ID} .epm-menu-option { min-height:68px; padding:12px 13px; }
        #${ROOT_ID} .epm-menu-option-title { font-size:15px; }
        #${ROOT_ID} .epm-menu-option-description { font-size:12px; }
        #${ROOT_ID} .epm-header { min-height:58px; gap:8px; padding:9px 12px; }
        #${ROOT_ID} .epm-logo { flex-basis:34px; width:34px; height:34px; }
        #${ROOT_ID} .epm-body { padding:14px 12px; }
        #${ROOT_ID} .epm-stats { gap:8px; }
        #${ROOT_ID} .epm-ring { width:min(100%,170px); border-width:7px; }
        #${ROOT_ID} .epm-ring-inner { border-width:7px; }
        #${ROOT_ID} .epm-excluded { padding:10px; }
        #${ROOT_ID} .epm-excluded-form { flex-direction:column; }
        #${ROOT_ID} .epm-excluded-submit { min-height:40px; }
        #${ROOT_ID} .epm-actions { grid-template-columns:1fr 1fr; gap:7px; }
        #${ROOT_ID} .epm-action { min-height:44px; padding:8px; font-size:14px; }
        #${ROOT_ID} .epm-action[data-mode="close"] { grid-column:1 / -1; min-height:38px; }
      }
      @media (prefers-reduced-motion:reduce) {
        #${ROOT_ID} *,
        #${ROOT_ID} *::before,
        #${ROOT_ID} *::after { scroll-behavior:auto !important; transition-duration:.01ms !important; }
      }
    `;
    document.head.append(style);
  }

  function showManager(userId) {
    if (document.getElementById(ROOT_ID)) return;
    addStyles();
    const iconUrl = chrome.runtime.getURL("EPM-icon-48.png");

    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.innerHTML = `
      <button class="epm-launcher" type="button">프로젝트 관리자</button>
      <div class="epm-menu-backdrop" hidden>
        <section class="epm-menu-modal" role="dialog" aria-modal="true" aria-labelledby="${ROOT_ID}-menu-title">
          <header class="epm-header">
            <img class="epm-logo" src="${iconUrl}" alt="" aria-hidden="true">
            <h2 class="epm-title" id="${ROOT_ID}-menu-title">엔트리 프로젝트 매니저</h2>
          </header>
          <div class="epm-menu-body">
            <p class="epm-menu-intro">내 작품 공개 설정을 관리하고 작품 통계를 확인합니다.</p>
            <p class="epm-menu-label">관리 메뉴</p>
            <div class="epm-menu-options">
              <button class="epm-menu-option" data-menu="visibility" type="button">
                <span class="epm-menu-option-copy">
                  <span class="epm-menu-option-title">작품 전체 공개/비공개</span>
                  <span class="epm-menu-option-description">일괄 변경 · 제외 작품 관리</span>
                </span>
                <span class="epm-menu-option-arrow" aria-hidden="true">›</span>
              </button>
              <button class="epm-menu-option" data-menu="stats" type="button">
                <span class="epm-menu-option-copy">
                  <span class="epm-menu-option-title">작품 통계</span>
                  <span class="epm-menu-option-description">공개 · 비공개 작품 현황</span>
                </span>
                <span class="epm-menu-option-arrow" aria-hidden="true">›</span>
              </button>
            </div>
            <div class="epm-menu-footer">
              <span>작품은 삭제하지 않고 공개 상태만 변경합니다.</span>
              <button class="epm-menu-close" data-menu-close type="button">닫기</button>
            </div>
          </div>
        </section>
      </div>
      <div class="epm-backdrop epm-stats-backdrop" hidden>
        <section class="epm-modal" role="dialog" aria-modal="true" aria-labelledby="${ROOT_ID}-stats-title">
          <header class="epm-header">
            <img class="epm-logo" src="${iconUrl}" alt="" aria-hidden="true">
            <h2 class="epm-title" id="${ROOT_ID}-stats-title">내 작품 종합 통계 (Statistics)</h2>
          </header>
          <div class="epm-body">
            <p class="epm-stats-result" data-stats-result role="status" aria-live="polite">작품 통계를 불러와 주세요.</p>
            <div class="epm-stats">
              <section class="epm-stat">
                <h3 class="epm-stat-title" data-mode="private">🔒 비공개 작품</h3>
                <div class="epm-ring" data-mode="private" style="--ring-color:#6957e8">
                  <div class="epm-ring-inner">
                    <span class="epm-ring-label">비공개 작품</span>
                    <strong class="epm-ring-count" data-count="private">—</strong>
                    <span class="epm-ring-total">/ <span data-count="total">—</span></span>
                  </div>
                </div>
              </section>
              <section class="epm-stat">
                <h3 class="epm-stat-title" data-mode="public">🌐 공개 작품</h3>
                <div class="epm-ring" data-mode="public" style="--ring-color:#17a797">
                  <div class="epm-ring-inner">
                    <span class="epm-ring-label">공개 작품</span>
                    <strong class="epm-ring-count" data-count="public">—</strong>
                    <span class="epm-ring-total">/ <span data-count="total">—</span></span>
                  </div>
                </div>
              </section>
            </div>
            <p class="epm-stats-summary" data-stats-summary>
              전체 <strong data-summary-total>—</strong> · 공개 <strong data-summary-public>—</strong> · 비공개 <strong data-summary-private>—</strong>
            </p>
            <section class="epm-stat-section" aria-labelledby="${ROOT_ID}-awards-heading">
              <h3 class="epm-stat-section-heading" id="${ROOT_ID}-awards-heading">🏆 수상 내역 (스선 &amp; 인작)</h3>
              <div class="epm-stat-cards">
                <article class="epm-stat-card">
                  <span class="epm-stat-card-label">🏅 스태프 선정</span>
                  <strong class="epm-stat-card-value" data-stat-awards="staff">—</strong>
                  <span class="epm-stat-card-note">작품 수</span>
                </article>
                <article class="epm-stat-card">
                  <span class="epm-stat-card-label">⭐ 인기 작품</span>
                  <strong class="epm-stat-card-value" data-stat-awards="ranked">—</strong>
                  <span class="epm-stat-card-note">작품 수</span>
                </article>
              </div>
            </section>
            <section class="epm-stat-section" aria-labelledby="${ROOT_ID}-reactions-heading">
              <h3 class="epm-stat-section-heading" id="${ROOT_ID}-reactions-heading">📌 전체 누적 반응</h3>
              <div class="epm-stat-cards" data-columns="3">
                <article class="epm-stat-card">
                  <span class="epm-stat-card-label">❤️ 좋아요</span>
                  <strong class="epm-stat-card-value" data-stat-reactions="likes">—</strong>
                </article>
                <article class="epm-stat-card">
                  <span class="epm-stat-card-label">💬 댓글</span>
                  <strong class="epm-stat-card-value" data-stat-reactions="comments">—</strong>
                </article>
                <article class="epm-stat-card">
                  <span class="epm-stat-card-label">🔖 북마크</span>
                  <strong class="epm-stat-card-value" data-stat-reactions="bookmarks">—</strong>
                  <span class="epm-stat-card-note">엔트리 작품 목록에서 합계를 제공하지 않음</span>
                </article>
              </div>
            </section>
            <section class="epm-stat-section" aria-labelledby="${ROOT_ID}-top-project-heading">
              <h3 class="epm-stat-section-heading" id="${ROOT_ID}-top-project-heading">🔥 최고 인기 작품</h3>
              <article class="epm-top-project">
                <h4 class="epm-top-project-name" data-top-project-name>작품 통계를 불러오면 표시됩니다.</h4>
                <p class="epm-top-project-summary" data-top-project-summary></p>
              </article>
            </section>
            <div class="epm-stats-actions">
              <button class="epm-action" data-stats-refresh type="button">↻ 통계 새로고침</button>
              <button class="epm-action" data-stats-menu type="button">메인 메뉴</button>
            </div>
          </div>
        </section>
      </div>
      <div class="epm-backdrop" hidden>
        <section class="epm-modal" role="dialog" aria-modal="true" aria-labelledby="${ROOT_ID}-title">
          <header class="epm-header">
            <img class="epm-logo" src="${iconUrl}" alt="" aria-hidden="true">
            <h2 class="epm-title" id="${ROOT_ID}-title">엔트리 작품 일괄 비공개/공개 매니저</h2>
          </header>
          <div class="epm-body">
            <div class="epm-stats">
              <section class="epm-stat">
                <h3 class="epm-stat-title" data-mode="private">🔒 비공개 작품</h3>
                <div class="epm-ring" data-mode="private" style="--ring-color:#6957e8">
                  <div class="epm-ring-inner">
                    <span class="epm-ring-label">비공개 작품</span>
                    <strong class="epm-ring-count" data-count="private">—</strong>
                    <span class="epm-ring-total">/ <span data-count="total">—</span></span>
                  </div>
                </div>
              </section>
              <section class="epm-stat">
                <h3 class="epm-stat-title" data-mode="public">🌐 공개 작품</h3>
                <div class="epm-ring" data-mode="public" style="--ring-color:#17a797">
                  <div class="epm-ring-inner">
                    <span class="epm-ring-label">공개 작품</span>
                    <strong class="epm-ring-count" data-count="public">—</strong>
                    <span class="epm-ring-total">/ <span data-count="total">—</span></span>
                  </div>
                </div>
              </section>
            </div>
            <section class="epm-excluded" aria-labelledby="${ROOT_ID}-excluded-title">
              <h3 class="epm-excluded-heading" id="${ROOT_ID}-excluded-title">
                <span>변경 제외 작품</span>
                <span><span data-excluded-count>0</span>개</span>
              </h3>
              <p class="epm-excluded-help">작품 링크를 추가하면 다음부터 공개/비공개 일괄 변경에서 건너뜁니다. 이 목록은 계정별로 저장됩니다.</p>
              <form class="epm-excluded-form" data-excluded-form>
                <input class="epm-excluded-input" data-excluded-input type="url" inputmode="url" placeholder="https://playentry.org/project/작품ID" aria-label="제외할 엔트리 작품 링크" required>
                <button class="epm-excluded-submit" data-excluded-submit type="submit">링크 추가</button>
              </form>
              <p class="epm-excluded-message" data-excluded-message aria-live="polite"></p>
              <ul class="epm-excluded-list" data-excluded-list aria-label="변경 제외 작품 목록"></ul>
            </section>
            <section class="epm-result" aria-live="polite">
              <h3 class="epm-result-heading"><span class="epm-result-icon" data-result-icon>✓</span><span data-result>내 작품을 불러와 주세요</span></h3>
              <div class="epm-progress-row">
                <div class="epm-progress-track" role="progressbar" aria-label="작업 진행률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                  <div class="epm-progress"></div>
                </div>
                <span class="epm-percent">0%</span>
              </div>
            </section>
            <section class="epm-log">
              <div class="epm-log-title"><span>작업 내역 (Log)</span><button class="epm-refresh" data-refresh type="button">↻ 새로고침</button></div>
              <ul class="epm-log-list" aria-label="작품 공개 상태 변경 로그"></ul>
            </section>
            <div class="epm-actions">
              <button class="epm-action" data-mode="private" type="button" disabled>모두 비공개 전환</button>
              <button class="epm-action" data-mode="public" type="button" disabled>모두 공개 전환</button>
              <button class="epm-action" data-mode="close" type="button">닫기</button>
            </div>
          </div>
        </section>
      </div>
    `;
    document.body.append(root);

    const backdrop = root.querySelector(".epm-backdrop:not(.epm-stats-backdrop)");
    const launcher = root.querySelector(".epm-launcher");
    const menuBackdrop = root.querySelector(".epm-menu-backdrop");
    const statsBackdrop = root.querySelector(".epm-stats-backdrop");
    const statsResult = root.querySelector("[data-stats-result]");
    const statsSummary = root.querySelector("[data-stats-summary]");
    const statsRefreshButton = root.querySelector("[data-stats-refresh]");
    const refreshButton = root.querySelector("[data-refresh]");
    const resultText = root.querySelector("[data-result]");
    const resultIcon = root.querySelector("[data-result-icon]");
    const logList = root.querySelector(".epm-log-list");
    const progress = root.querySelector(".epm-progress");
    const progressBar = root.querySelector('[role="progressbar"]');
    const percentText = root.querySelector(".epm-percent");
    const actionButtons = root.querySelectorAll('.epm-action[data-mode]:not([data-mode="close"])');
    let projects = null;
    let excludedProjects = [];
    let excludedProjectsLoaded = false;
    const excludedStorageKey = `${EXCLUDED_PROJECTS_STORAGE_PREFIX}${userId}`;
    const excludedList = root.querySelector("[data-excluded-list]");
    const excludedCount = root.querySelector("[data-excluded-count]");
    const excludedForm = root.querySelector("[data-excluded-form]");
    const excludedInput = root.querySelector("[data-excluded-input]");
    const excludedMessage = root.querySelector("[data-excluded-message]");
    const excludedSubmit = root.querySelector("[data-excluded-submit]");

    function addLog(message, kind = "success") {
      const item = document.createElement("li");
      item.className = "epm-log-item";
      item.dataset.kind = kind;
      const mark = document.createElement("span");
      mark.className = "epm-log-mark";
      mark.textContent = kind === "success" ? "✓" : kind === "error" ? "!" : "•";
      const text = document.createElement("span");
      text.textContent = message;
      item.append(mark, text);
      logList.append(item);
      logList.scrollTop = logList.scrollHeight;
    }

    function setProgress(done, total) {
      const percentage = total === 0 ? 100 : Math.floor((done / total) * 100);
      progress.style.width = `${percentage}%`;
      percentText.textContent = `${percentage}%`;
      progressBar.setAttribute("aria-valuenow", String(percentage));
    }

    function updateStats(projectList) {
      const privateCount = projectList.filter((project) => !project.isopen).length;
      const publicCount = projectList.length - privateCount;
      const likes = projectList.reduce(
        (total, project) => total + project.likeCnt,
        0,
      );
      const comments = projectList.reduce(
        (total, project) => total + project.comment,
        0,
      );
      const topProject = projectList.reduce(
        (top, project) => (project.likeCnt > (top?.likeCnt ?? -1) ? project : top),
        null,
      );
      const staffPickedCount = projectList.filter(
        (project) => project.staffPicked,
      ).length;
      const rankedCount = projectList.filter((project) => project.ranked).length;
      root.querySelectorAll('[data-count="private"]').forEach((element) => {
        element.textContent = String(privateCount);
      });
      root.querySelectorAll('[data-count="public"]').forEach((element) => {
        element.textContent = String(publicCount);
      });
      root.querySelectorAll('[data-count="total"]').forEach((element) => {
        element.textContent = String(projectList.length);
      });
      for (const [mode, count] of [["private", privateCount], ["public", publicCount]]) {
        root.querySelectorAll(`.epm-ring[data-mode="${mode}"]`).forEach((ring) => {
          ring.style.setProperty(
            "--ring-value",
            `${projectList.length ? (count / projectList.length) * 100 : 0}%`,
          );
        });
      }
      const summaryValues = {
        total: statsSummary.querySelector("[data-summary-total]"),
        public: statsSummary.querySelector("[data-summary-public]"),
        private: statsSummary.querySelector("[data-summary-private]"),
      };
      const privatePercentage = projectList.length
        ? Math.round((privateCount / projectList.length) * 100)
        : 0;
      const publicPercentage = projectList.length
        ? Math.round((publicCount / projectList.length) * 100)
        : 0;
      summaryValues.total.textContent = `${projectList.length}개`;
      summaryValues.public.textContent =
        `${publicCount}개 (${publicPercentage}%)`;
      summaryValues.private.textContent =
        `${privateCount}개 (${privatePercentage}%)`;
      root.querySelector('[data-stat-awards="staff"]').textContent =
        `${staffPickedCount}개`;
      root.querySelector('[data-stat-awards="ranked"]').textContent =
        `${rankedCount}개`;
      root.querySelector('[data-stat-reactions="likes"]').textContent =
        likes.toLocaleString("ko-KR");
      root.querySelector('[data-stat-reactions="comments"]').textContent =
        comments.toLocaleString("ko-KR");
      const topProjectName = root.querySelector("[data-top-project-name]");
      const topProjectSummary = root.querySelector("[data-top-project-summary]");
      if (topProject && likes > 0) {
        const likeShare = likes
          ? Math.round((topProject.likeCnt / likes) * 100)
          : 0;
        topProjectName.textContent = `[${topProject.name}]`;
        topProjectSummary.textContent =
          `이 작품이 전체 좋아요의 ${likeShare}%를 차지하고 있어요! 유저들의 반응이 가장 뜨겁습니다.`;
      } else {
        topProjectName.textContent = projectList.length
          ? "아직 좋아요를 받은 작품이 없습니다."
          : "표시할 작품이 없습니다.";
        topProjectSummary.textContent = projectList.length
          ? "좋아요 데이터가 쌓이면 가장 인기 있는 작품을 보여 드립니다."
          : "작품 목록을 새로고침해 통계를 확인해 주세요.";
      }
    }

    function renderExcludedProjects() {
      excludedList.replaceChildren();
      excludedCount.textContent = String(excludedProjects.length);
      for (const excluded of excludedProjects) {
        const item = document.createElement("li");
        item.className = "epm-excluded-item";
        const link = document.createElement("a");
        link.href = excluded.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = excluded.name;
        link.title = excluded.url;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "제외 해제";
        remove.setAttribute("aria-label", `${excluded.name} 제외 해제`);
        remove.addEventListener("click", async () => {
          if (isRunning) return;
          isRunning = true;
          remove.disabled = true;
          excludedSubmit.disabled = true;
          try {
            const updated = excludedProjects.filter(
              (entry) => entry.id !== excluded.id,
            );
            await chrome.storage.local.set({
              [excludedStorageKey]: updated,
            });
            excludedProjects = updated;
            excludedMessage.textContent = "제외 목록에서 삭제했습니다.";
            excludedMessage.dataset.kind = "success";
            renderExcludedProjects();
          } catch (error) {
            console.error("[엔트리 작품 공개 관리] 제외 목록 저장 실패", error);
            excludedMessage.textContent = `제외 해제에 실패했습니다: ${error.message}`;
            excludedMessage.dataset.kind = "error";
          } finally {
            isRunning = false;
            excludedSubmit.disabled = false;
          }
        });
        item.append(link, remove);
        excludedList.append(item);
      }
      if (!excludedProjects.length) {
        const empty = document.createElement("li");
        empty.className = "epm-excluded-empty";
        empty.textContent = "제외한 작품이 없습니다.";
        excludedList.append(empty);
      }
    }

    async function loadExcludedProjects() {
      if (excludedProjectsLoaded) return;
      if (typeof chrome === "undefined" || !chrome.storage?.local) {
        throw new Error("확장 프로그램 저장소를 사용할 수 없습니다. 확장 프로그램을 다시 불러와 주세요.");
      }
      const stored = await chrome.storage.local.get(excludedStorageKey);
      const savedList = stored[excludedStorageKey];
      if (savedList !== undefined && !Array.isArray(savedList)) {
        throw new Error("저장된 제외 목록 형식이 올바르지 않습니다.");
      }
      excludedProjects = (savedList || []).filter(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.name === "string" &&
          typeof entry.url === "string",
      );
      excludedProjectsLoaded = true;
      renderExcludedProjects();
    }

    function getProjectIdFromLink(value) {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error("엔트리 작품 링크를 올바르게 입력해 주세요.");
      }
      if (
        url.protocol !== "https:" ||
        !["playentry.org", "www.playentry.org"].includes(url.hostname) ||
        url.username ||
        url.password
      ) {
        throw new Error("https://playentry.org 의 작품 링크만 추가할 수 있습니다.");
      }
      const segments = url.pathname.split("/").filter(Boolean);
      const projectId = segments[0] === "project" ? segments[1] : null;
      if (!projectId || !/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) {
        throw new Error("링크에서 작품 ID를 찾을 수 없습니다. 작품 페이지 주소를 입력해 주세요.");
      }
      return projectId;
    }

    excludedForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (isRunning) return;
      isRunning = true;
      excludedSubmit.disabled = true;
      excludedMessage.textContent = "";
      delete excludedMessage.dataset.kind;
      try {
        await loadExcludedProjects();
        const projectId = getProjectIdFromLink(excludedInput.value.trim());
        if (excludedProjects.some((entry) => entry.id === projectId)) {
          throw new Error("이미 제외 목록에 추가된 작품입니다.");
        }
        const project = projects?.find((entry) => entry.id === projectId);
        const entry = {
          id: projectId,
          name: project?.name || `작품 (${projectId})`,
          url: `https://playentry.org/project/${encodeURIComponent(projectId)}`,
        };
        const updated = [...excludedProjects, entry];
        await chrome.storage.local.set({
          [excludedStorageKey]: updated,
        });
        excludedProjects = updated;
        renderExcludedProjects();
        excludedInput.value = "";
        excludedMessage.textContent = "제외 목록에 저장했습니다. 다음 실행부터 변경 대상에서 건너뜁니다.";
        excludedMessage.dataset.kind = "success";
      } catch (error) {
        console.error("[엔트리 작품 공개 관리] 제외 목록 저장 실패", error);
        excludedMessage.textContent = error.message;
        excludedMessage.dataset.kind = "error";
      } finally {
        isRunning = false;
        excludedSubmit.disabled = false;
      }
    });

    async function loadProjects() {
      if (isRunning) return;
      isRunning = true;
      projects = null;
      actionButtons.forEach((button) => (button.disabled = true));
      refreshButton.disabled = true;
      resultText.textContent = "내 작품 목록을 확인하고 있습니다...";
      resultIcon.textContent = "…";
      logList.replaceChildren();
      setProgress(0, 1);
      addLog("전체 작품 목록을 안전하게 불러오는 중입니다.", "info");
      try {
        await loadExcludedProjects();
        projects = await fetchAllProjects(userId);
        updateStats(projects);
        setProgress(projects.length, projects.length);
        resultText.textContent = `내 작품 ${projects.length}개 확인 완료`;
        resultIcon.textContent = "✓";
        addLog(`작품 ${projects.length}개를 모두 확인했습니다. 작품은 그대로 유지됩니다.`);
        actionButtons.forEach((button) => (button.disabled = false));
      } catch (error) {
        console.error("[엔트리 작품 공개 관리]", error);
        resultText.textContent = "작품 목록을 불러오지 못했습니다";
        resultIcon.textContent = "!";
        addLog(error.message, "error");
        if (!excludedProjectsLoaded) {
          excludedMessage.textContent = `제외 목록을 불러오지 못했습니다: ${error.message}`;
          excludedMessage.dataset.kind = "error";
        }
      } finally {
        isRunning = false;
        actionButtons.forEach((button) => (button.disabled = !projects));
        refreshButton.disabled = false;
      }
    }

    async function openManager() {
      menuBackdrop.hidden = true;
      statsBackdrop.hidden = true;
      backdrop.hidden = false;
      if (!projects) await loadProjects();
      if (!projects) {
        throw new Error("작품 목록을 불러오지 못했습니다. 대시보드에서 다시 시도해 주세요.");
      }
    }
    openManagerFromExtension = openManager;

    async function loadStatistics() {
      if (isRunning) return;
      isRunning = true;
      statsRefreshButton.disabled = true;
      statsResult.textContent = "전체 작품 목록을 확인하고 있습니다...";
      delete statsResult.dataset.kind;
      try {
        projects = await fetchAllProjects(userId);
        updateStats(projects);
        statsResult.textContent = `${projects.length}개 작품의 통계를 확인했습니다.`;
      } catch (error) {
        console.error("[엔트리 작품 통계]", error);
        statsResult.textContent = `통계를 불러오지 못했습니다: ${error.message}`;
        statsResult.dataset.kind = "error";
        throw error;
      } finally {
        isRunning = false;
        statsRefreshButton.disabled = false;
      }
    }

    async function openStatistics() {
      menuBackdrop.hidden = true;
      backdrop.hidden = true;
      statsBackdrop.hidden = false;
      await loadStatistics();
    }
    openStatsFromExtension = openStatistics;

    function openMainMenu() {
      backdrop.hidden = true;
      statsBackdrop.hidden = true;
      menuBackdrop.hidden = false;
    }
    openMainMenuFromExtension = openMainMenu;

    function closeMainMenu() {
      menuBackdrop.hidden = true;
    }

    function closeManager() {
      if (!isRunning) backdrop.hidden = true;
    }

    launcher.addEventListener("click", openMainMenu);
    root.querySelector('[data-menu="visibility"]').addEventListener("click", () => {
      void openManager().catch((error) => {
        console.error("[엔트리 작품 공개 관리]", error);
      });
    });
    root.querySelector('[data-menu="stats"]').addEventListener("click", () => {
      void openStatistics().catch(() => {});
    });
    root.querySelector("[data-menu-close]").addEventListener("click", closeMainMenu);
    menuBackdrop.addEventListener("click", (event) => {
      if (event.target === menuBackdrop) closeMainMenu();
    });
    statsRefreshButton.addEventListener("click", () => {
      void loadStatistics().catch(() => {});
    });
    root.querySelector("[data-stats-menu]").addEventListener("click", openMainMenu);
    statsBackdrop.addEventListener("click", (event) => {
      if (event.target === statsBackdrop) openMainMenu();
    });
    refreshButton.addEventListener("click", loadProjects);
    root.querySelector('[data-mode="close"]').addEventListener("click", closeManager);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeManager();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!menuBackdrop.hidden) closeMainMenu();
        else if (!statsBackdrop.hidden) openMainMenu();
        else if (!backdrop.hidden) closeManager();
      }
    });
    actionButtons.forEach((button) => {
      button.addEventListener("click", async () => {
        if (isRunning || !projects) return;
        isRunning = true;
        let reloadAfterCompletion = false;
        actionButtons.forEach((item) => (item.disabled = true));

        try {
          const desiredPublic = button.dataset.mode === "public";
          const excludedIds = new Set(
            excludedProjects.map((excluded) => excluded.id),
          );
          const eligibleProjects = projects.filter(
            (project) => !excludedIds.has(project.id),
          );
          const excludedCount = projects.length - eligibleProjects.length;
          const targets = eligibleProjects.filter(
            (project) => project.isopen !== desiredPublic,
          );
          const action = desiredPublic ? "공개" : "비공개";
          const confirmed = window.confirm(
            `내 작품 ${projects.length}개 중 제외 목록 ${excludedCount}개를 건너뛰고 ${targets.length}개를 ${action}로 변경합니다.\n\n작품 자체는 삭제되지 않습니다. 계속할까요?`,
          );
          if (!confirmed) {
            resultText.textContent = "변경을 취소했습니다";
            addLog("취소했습니다. 작품은 변경되지 않았습니다.", "info");
            return;
          }

          logList.replaceChildren();
          refreshButton.disabled = true;
          setProgress(0, targets.length);
          resultText.textContent = `${action} 상태로 변경 중... (${targets.length}개 작품)`;
          resultIcon.textContent = "…";
          addLog(
            `전체 ${projects.length}개 중 제외 ${excludedCount}개를 건너뛰고 ${targets.length}개 작품을 ${action}로 변경합니다.`,
            "info",
          );
          if (!targets.length) {
            setProgress(0, 0);
            resultText.textContent = excludedCount === projects.length
              ? "모든 작품이 제외 목록에 있어 변경하지 않았습니다"
              : `변경할 작품이 없습니다 (${excludedCount}개 제외, 나머지는 이미 ${action})`;
            resultIcon.textContent = "✓";
            addLog(
              excludedCount === projects.length
                ? "모든 작품이 제외 목록에 있어 아무 작품도 변경하지 않았습니다."
                : `변경할 작품이 없습니다. 제외 목록 ${excludedCount}개를 건너뛰었습니다.`,
            );
            return;
          }

          let changed = 0;
          for (const project of targets) {
            await toggleProject(project);
            changed += 1;
            project.isopen = desiredPublic;
            setProgress(changed, targets.length);
            resultText.textContent = `상태 변경 중... (${changed}/${targets.length}개 작품)`;
            addLog(`[${action} 완료] ${project.name}`);
          }

          updateStats(projects);
          resultText.textContent = `상태 변경 완료! 페이지를 새로고침합니다`;
          resultIcon.textContent = "✓";
          addLog(
            `${changed}개 작품의 ${action} 전환 요청이 완료되었습니다. 제외 목록 ${excludedCount}개는 건너뛰었습니다. 페이지를 새로고침해 상태를 반영합니다. 작품은 모두 유지되었습니다.`,
          );
          reloadAfterCompletion = true;
          window.setTimeout(() => window.location.reload(), 1200);
        } catch (error) {
          console.error("[엔트리 작품 공개 관리]", error);
          resultText.textContent = "작업 중 오류가 발생했습니다";
          resultIcon.textContent = "!";
          const message =
            error instanceof Error ? error.message : String(error);
          addLog(
            `${message} 부분 변경이 있을 수 있습니다. 페이지를 새로고침해 확인해 주세요.`,
            "error",
          );
          try {
            projects = await fetchAllProjects(userId);
            updateStats(projects);
          } catch (refreshError) {
            projects = null;
            addLog(`현재 상태를 다시 확인하지 못했습니다: ${refreshError.message}`, "error");
          }
        } finally {
          isRunning = false;
          refreshButton.disabled = false;
          actionButtons.forEach(
            (item) => (item.disabled = !projects || reloadAfterCompletion),
          );
        }
      });
    });
  }

  function syncManager() {
    const pageUserId = getPageUserId();
    const canManageProfile = pageUserId && isSignedIn();

    if (!canManageProfile) {
      document.getElementById(ROOT_ID)?.remove();
      activeUserId = null;
      return;
    }

    if (activeUserId !== pageUserId) {
      document.getElementById(ROOT_ID)?.remove();
      activeUserId = pageUserId;
    }
    showManager(pageUserId);
  }

  const observer = new MutationObserver(syncManager);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", syncManager);
  syncManager();

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const openStats = message?.type === "ENTRY_PROJECT_MANAGER_OPEN_STATS";
      const openMenu = message?.type === "ENTRY_PROJECT_MANAGER_OPEN_MENU";
      const openVisibility =
        message?.type === "ENTRY_PROJECT_MANAGER_OPEN_VISIBILITY" ||
        message?.type === "ENTRY_PROJECT_MANAGER_OPEN";
      if (
        !openVisibility &&
        !openStats &&
        !openMenu
      ) {
        return false;
      }

      const pageUserId = getPageUserId();
      if (!pageUserId || !isSignedIn()) {
        sendResponse({
          ok: false,
          error:
            "엔트리에 로그인한 뒤 프로필 페이지를 새로고침하고 확장 아이콘을 다시 눌러 주세요.",
        });
        return false;
      }

      if (
        !openManagerFromExtension ||
        !openMainMenuFromExtension ||
        !openStatsFromExtension
      ) {
        showManager(pageUserId);
      }
      if (
        !openManagerFromExtension ||
        !openMainMenuFromExtension ||
        !openStatsFromExtension
      ) {
        sendResponse({
          ok: false,
          error: "대시보드를 준비하지 못했습니다. 프로필 페이지를 새로고침해 주세요.",
        });
        return false;
      }

      let openRequestedView;
      switch (true) {
        case openMenu:
          openRequestedView = Promise.resolve().then(
            () => openMainMenuFromExtension(),
          );
          break;
        case openStats:
          openRequestedView = openStatsFromExtension();
          break;
        case openVisibility:
          openRequestedView = openManagerFromExtension();
          break;
        default:
          sendResponse({
            ok: false,
            error: "요청한 화면을 확인할 수 없습니다.",
          });
          return false;
      }
      openRequestedView
        .then(() => {
          sendResponse({ ok: true });
        })
        .catch((error) =>
          sendResponse({
            ok: false,
            error: `요청한 화면을 열지 못했습니다: ${error.message}`,
          }),
        );
      return true;
    });
  }
})();
