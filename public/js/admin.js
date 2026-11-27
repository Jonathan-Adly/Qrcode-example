// Small progressive enhancements shared by admin pages.
(function () {
  'use strict';

  // <form data-confirm="Are you sure?"> asks before submitting.
  document.addEventListener('submit', (event) => {
    const message = event.target.dataset && event.target.dataset.confirm;
    if (message && !window.confirm(message)) event.preventDefault();
  });

  // <button data-copy="text"> copies text to the clipboard.
  document.addEventListener('click', async (event) => {
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
      const original = copyButton.textContent;
      try {
        await navigator.clipboard.writeText(copyButton.dataset.copy);
        copyButton.textContent = 'Copied!';
      } catch {
        copyButton.textContent = 'Copy failed';
      }
      setTimeout(() => { copyButton.textContent = original; }, 1500);
    }

    if (event.target.closest('[data-print]')) window.print();
  });

  // Show server timestamps in the admin's own time zone.
  for (const el of document.querySelectorAll('time[data-local-time]')) {
    el.textContent = new Date(el.dateTime).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }
})();
