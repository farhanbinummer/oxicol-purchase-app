// Sets the light/dark theme before the page paints, so a dark-mode user never sees a bright flash.
// Runs from <head>; common.js keeps the same 'oxicol_theme' preference when the toggle is used.
(function () {
  var theme = 'light';
  try {
    var saved = localStorage.getItem('oxicol_theme');
    theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (e) {}
  document.documentElement.setAttribute('data-theme', theme);
})();
