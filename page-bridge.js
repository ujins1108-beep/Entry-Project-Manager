(() => {
  "use strict";

  const CHANNEL = "entry-project-manager-auth-bridge";
  const TOGGLE_QUERY = `
    mutation TOGGLE_ISOPEN_PROJECT($id: ID!) {
      toggleIsopenProject(id: $id) {
        status
        result
      }
    }
  `;
  const DELETE_QUERY = `
    mutation DELETE_PROJECT($id: ID!) {
      deleteProject(id: $id) {
        status
        result
      }
    }
  `;
  const pageFetch = window.fetch.bind(window);
  let pageAuthToken = null;

  window.fetch = function (input, init) {
    const requestUrl =
      typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsedUrl = new URL(requestUrl, window.location.href);

    if (
      parsedUrl.origin === window.location.origin &&
      parsedUrl.pathname.startsWith("/graphql/")
    ) {
      const requestHeaders =
        input instanceof Request ? new Headers(input.headers) : new Headers();
      if (init?.headers) {
        new Headers(init.headers).forEach((value, name) => {
          requestHeaders.set(name, value);
        });
      }
      const xToken = requestHeaders.get("x-token");
      if (xToken) pageAuthToken = xToken;
    }

    return pageFetch(input, init);
  };

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      message?.channel !== CHANNEL ||
      !["TOGGLE_PROJECT", "DELETE_PROJECT"].includes(message.type)
    ) {
      return;
    }

    const operation =
      message.type === "DELETE_PROJECT"
        ? { name: "DELETE_PROJECT", query: DELETE_QUERY }
        : { name: "TOGGLE_ISOPEN_PROJECT", query: TOGGLE_QUERY };
    const requestId = message.requestId;
    const projectId = message.projectId;
    let response;

    if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 100) {
      response = { ok: false, error: "작품 ID가 올바르지 않습니다." };
    } else if (!pageAuthToken) {
      response = {
        ok: false,
        error:
          "엔트리 로그인 인증 정보를 찾지 못했습니다. 프로필 페이지를 새로고침한 뒤 다시 시도해 주세요.",
      };
    } else {
      try {
        const csrfToken = document
          .querySelector('meta[name="csrf-token"]')
          ?.getAttribute("content");
        const headers = {
          "Content-Type": "application/json",
          "X-Client-Type": "Client",
          "x-token": pageAuthToken,
        };
        if (csrfToken) headers["CSRF-Token"] = csrfToken;

        const result = await pageFetch(
          `${window.location.origin}/graphql/${operation.name}`,
          {
            method: "POST",
            credentials: "include",
            headers,
            body: JSON.stringify({
              operationName: operation.name,
              query: operation.query,
              variables: { id: projectId },
            }),
          },
        );
        const body = await result.json();
        if (!result.ok) {
          const reason =
            body?.errors?.map((error) => error.message).join("; ") ||
            body?.message ||
            `엔트리 서버 HTTP ${result.status}`;
          response = { ok: false, error: reason };
        } else if (body?.errors?.length) {
          response = {
            ok: false,
            error: body.errors.map((error) => error.message).join("; "),
          };
        } else {
          response = { ok: true, data: body?.data };
        }
      } catch (error) {
        response = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    window.postMessage(
      { channel: CHANNEL, type: `${message.type}_RESULT`, requestId, ...response },
      window.location.origin,
    );
  });
})();
