// Staff pages live inside the /app workspace as tabs. Runs in <head> before the page paints.
(function () {
  var html = document.documentElement;
  var shell = html.getAttribute('data-shell') === '1';
  var framed = window.top !== window;
  if (framed) {
    // Login / customer pages inside a tab (e.g. session expired): take over the whole window.
    if (!shell) { window.top.location.href = location.href; return; }
    html.classList.add('embedded');
  } else if (shell) {
    // A staff page opened directly (bookmark, email link): open it as a tab in the workspace.
    location.replace('/app?open=' + encodeURIComponent(location.pathname + location.search + location.hash));
  }
})();
