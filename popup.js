(() => {
  "use strict";

  const status = document.getElementById("status");
  const visibilityButton = document.getElementById("open-visibility");
  const statsButton = document.getElementById("open-stats");
  const menuButtons = [visibilityButton, statsButton];

  function showStatus(message, kind = "info") {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function openDashboard(view = "visibility") {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) {
      showStatus(
        "이 메뉴는 Chrome 또는 Edge에 설치된 확장 프로그램에서 사용할 수 있습니다.",
        "error",
      );
      return;
    }

    menuButtons.forEach((button) => (button.disabled = true));
    showStatus(
      view === "stats"
        ? "작품 통계를 불러오는 중..."
        : "작품 공개 관리 화면을 여는 중...",
    );
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id || !tab.url?.startsWith("https://playentry.org/")) {
        showStatus(
          "https://playentry.org 의 내 프로필 페이지를 열고 메뉴를 다시 선택해 주세요.",
          "error",
        );
        menuButtons.forEach((button) => (button.disabled = false));
        return;
      }

      chrome.tabs.sendMessage(
        tab.id,
        {
          type:
            view === "stats"
              ? "ENTRY_PROJECT_MANAGER_OPEN_STATS"
              : "ENTRY_PROJECT_MANAGER_OPEN_VISIBILITY",
        },
        (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            showStatus(
              "엔트리 탭에 확장 프로그램이 아직 연결되지 않았습니다. 프로필 페이지를 새로고침한 뒤 다시 시도해 주세요.",
              "error",
            );
            menuButtons.forEach((button) => (button.disabled = false));
            return;
          }
          if (!response?.ok) {
            showStatus(
              response?.error ??
                "엔트리에 로그인한 뒤 프로필 페이지를 새로고침하고 다시 눌러 주세요.",
              "error",
            );
            menuButtons.forEach((button) => (button.disabled = false));
            return;
          }
          showStatus(
            view === "stats"
              ? "작품 통계 화면을 열었습니다."
              : "작품 공개 관리 화면을 열었습니다.",
            "success",
          );
          window.setTimeout(() => window.close(), 250);
        },
      );
    });
  }

  function initialize() {
    menuButtons.forEach((button) => (button.disabled = false));
    showStatus("관리할 기능을 선택하세요.");
  }

  visibilityButton.addEventListener("click", () => openDashboard());
  statsButton.addEventListener("click", () => openDashboard("stats"));
  initialize();
})();
