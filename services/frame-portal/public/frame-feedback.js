/* Shared, quiet feedback for FRAME control pages. Healthy polling never calls notify. */
(() => {
  const issues = new Map();
  let serial = 0;
  let toastTimer;
  let toastMessage = "";
  let toastTime = 0;
  const toast = document.createElement("div");
  toast.className = "frame-feedback-toast";
  toast.hidden = true;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.setAttribute("aria-atomic", "true");
  document.body.append(toast);

  function shortMessage(message) {
    const text = String(message || "").trim();
    if (text.length <= 160) return text;
    const firstSentence = text.match(/^.{15,150}?[.!?](?:\s|$)/)?.[0]?.trim();
    return firstSentence || "An issue needs your attention. Open the indicator for details.";
  }

  function notify(message, { tone = "info", summary } = {}) {
    const text = String(summary || message || "").trim();
    if (!text || (text === toastMessage && Date.now() - toastTime < 5000)) return;
    toastMessage = text;
    toastTime = Date.now();
    clearTimeout(toastTimer);
    const host = document.querySelector("dialog[open]") || document.body;
    if (toast.parentElement !== host) host.append(toast);
    toast.dataset.tone = tone;
    toast.textContent = text;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
  }

  function isOpen(entry) {
    return entry.nativePopover ? entry.bubble.matches(":popover-open") : !entry.bubble.hidden;
  }

  function positionBubble(entry) {
    const anchor = entry.button.getBoundingClientRect();
    const width = Math.min(380, Math.max(240, window.innerWidth - 24));
    entry.bubble.style.width = `${width}px`;
    entry.bubble.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
    const height = entry.bubble.getBoundingClientRect().height;
    entry.bubble.style.top = `${Math.max(12, anchor.bottom + 8 + height < window.innerHeight - 12
      ? anchor.bottom + 8 : Math.min(anchor.top - height - 8, window.innerHeight - height - 12))}px`;
  }

  function positionHint(entry) {
    const anchor = entry.button.getBoundingClientRect();
    const hint = entry.hint.getBoundingClientRect();
    entry.hint.style.left = `${Math.max(12, Math.min(anchor.right - hint.width, window.innerWidth - hint.width - 12))}px`;
    entry.hint.style.top = `${Math.max(12, anchor.bottom + hint.height + 6 < window.innerHeight - 12
      ? anchor.bottom + 6 : anchor.top - hint.height - 6)}px`;
  }

  function closeBubble(entry, returnFocus = false) {
    if (isOpen(entry)) {
      if (entry.nativePopover) entry.bubble.hidePopover();
      else entry.bubble.hidden = true;
    }
    entry.button.setAttribute("aria-expanded", "false");
    entry.wrapper.classList.remove("frame-issue-open");
    if (returnFocus && entry.button.isConnected) {
      entry.button.focus();
      entry.wrapper.classList.add("frame-issue-hint-dismissed");
    }
  }

  function mount(entry) {
    const target = typeof entry.target === "string" ? document.querySelector(entry.target) : entry.target;
    if (!target?.isConnected) {
      closeBubble(entry);
      entry.wrapper.remove();
      return;
    }
    const control = /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(target.tagName);
    const parent = control ? target.parentElement : target;
    if (entry.wrapper.parentElement !== parent) {
      const wasOpen = entry.button.getAttribute("aria-expanded") === "true";
      closeBubble(entry);
      if (control) target.after(entry.wrapper);
      else target.append(entry.wrapper);
      if (wasOpen) {
        if (entry.nativePopover) entry.bubble.showPopover();
        else entry.bubble.hidden = false;
        entry.button.setAttribute("aria-expanded", "true");
        entry.wrapper.classList.add("frame-issue-open");
        positionBubble(entry);
      }
    }
  }

  function issue(key, { message, tone = "warning", target, summary, action } = {}) {
    if (!message) return clearIssue(key);
    let entry = issues.get(key);
    const newIssue = !entry;
    if (!entry) {
      const id = `frame-issue-${++serial}`;
      const wrapper = document.createElement("span");
      wrapper.className = "frame-issue";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "frame-issue-button";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", `${id}-details`);
      button.setAttribute("aria-describedby", `${id}-hint`);
      const hint = document.createElement("span");
      hint.className = "frame-issue-hint";
      hint.id = `${id}-hint`;
      hint.setAttribute("role", "tooltip");
      const bubble = document.createElement("div");
      bubble.className = "frame-issue-details";
      bubble.id = `${id}-details`;
      bubble.setAttribute("popover", "auto");
      bubble.setAttribute("role", "dialog");
      bubble.setAttribute("aria-labelledby", `${id}-title`);
      const heading = document.createElement("strong");
      heading.id = `${id}-title`;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "frame-issue-close";
      close.textContent = "×";
      close.setAttribute("aria-label", "Close details");
      const body = document.createElement("p");
      const actionButton = document.createElement("button");
      actionButton.type = "button";
      actionButton.className = "frame-issue-action";
      actionButton.hidden = true;
      bubble.append(heading, close, body, actionButton);
      wrapper.append(button, hint, bubble);
      entry = { wrapper, button, hint, bubble, heading, body, actionButton, nativePopover: typeof bubble.showPopover === "function" };
      if (!entry.nativePopover) bubble.hidden = true;
      button.addEventListener("click", () => {
        if (isOpen(entry)) return closeBubble(entry);
        for (const other of issues.values()) closeBubble(other);
        if (entry.nativePopover) bubble.showPopover();
        else bubble.hidden = false;
        button.setAttribute("aria-expanded", "true");
        wrapper.classList.add("frame-issue-open");
        positionBubble(entry);
      });
      wrapper.addEventListener("pointerenter", () => positionHint(entry));
      wrapper.addEventListener("focusin", () => positionHint(entry));
      close.addEventListener("click", () => closeBubble(entry, true));
      bubble.addEventListener("toggle", () => {
        const open = isOpen(entry);
        button.setAttribute("aria-expanded", String(open));
        wrapper.classList.toggle("frame-issue-open", open);
      });
      actionButton.addEventListener("click", async () => {
        actionButton.disabled = true;
        try { await entry.action?.onClick?.(); }
        catch (error) {
          entry.body.textContent = `${entry.message}\n\n${error.message || error}`;
        } finally {
          actionButton.disabled = false;
          if (isOpen(entry)) positionBubble(entry);
        }
      });
      issues.set(key, entry);
    }
    const severity = tone === "error" ? "error" : "warning";
    const brief = summary || shortMessage(message);
    entry.target = target;
    entry.message = String(message);
    entry.action = action;
    entry.wrapper.dataset.tone = severity;
    entry.bubble.dataset.tone = severity;
    entry.button.setAttribute("aria-label", `${severity === "error" ? "Error" : "Warning"}: ${brief}. Open details`);
    entry.button.innerHTML = severity === "error"
      ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4v.01"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.01"/></svg>';
    entry.hint.textContent = brief;
    entry.heading.textContent = severity === "error" ? "Action needed" : "Please check";
    entry.body.textContent = entry.message;
    entry.actionButton.hidden = !action?.label;
    entry.actionButton.textContent = action?.label || "";
    mount(entry);
    if (isOpen(entry)) positionBubble(entry);
    // Only announce a new problem. Repeated polling updates its details silently.
    if (newIssue) notify(brief, { tone: severity });
    return entry.wrapper;
  }

  function clearIssue(key, { notify: recovery } = {}) {
    const entry = issues.get(key);
    if (!entry) return;
    closeBubble(entry);
    entry.wrapper.remove();
    issues.delete(key);
    if (recovery) notify(recovery, { tone: "success" });
  }

  // Tool lists rebuild their contents when data refreshes; keep the issue with its feature.
  new MutationObserver(() => { for (const entry of issues.values()) mount(entry); })
    .observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (event) => {
    for (const entry of issues.values()) {
      if (!entry.nativePopover && !entry.wrapper.contains(event.target)) closeBubble(entry);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const entry of issues.values()) {
      entry.wrapper.classList.add("frame-issue-hint-dismissed");
      if (!entry.nativePopover) closeBubble(entry, true);
    }
  });
  document.addEventListener("pointerover", (event) => {
    event.target.closest?.(".frame-issue")?.classList.remove("frame-issue-hint-dismissed");
  });
  document.addEventListener("focusin", (event) => {
    event.target.closest?.(".frame-issue")?.classList.remove("frame-issue-hint-dismissed");
  });
  const reposition = () => { for (const entry of issues.values()) if (isOpen(entry)) positionBubble(entry); };
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  window.FrameFeedback = { notify, issue, clearIssue };
})();
