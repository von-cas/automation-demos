// Runs before paint so a saved theme choice does not flash. Default follows the system setting.
try {
  var t = localStorage.getItem('vondemo-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* storage blocked: follow the system */ }
