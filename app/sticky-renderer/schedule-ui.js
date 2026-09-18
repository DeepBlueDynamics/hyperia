// Scheduling overlay — same IPC payload as before.
'use strict';

function start(ctx) {
  const {doc, ipc, persist} = ctx;
  const $ = (id) => doc.getElementById(id);
  const overlay = $('schedOverlay');
  const scheduleBtn = $('scheduleBtn');
  if (!overlay) return;

  function syncRows() {
    const when = $('schedWhen').value;
    $('rowReminder').style.display = when === 'reminder' ? '' : 'none';
    $('rowAt').style.display = when === 'at' ? '' : 'none';
    $('rowCron').style.display = when === 'cron' ? '' : 'none';
    const runner = $('schedRunner').value;
    $('rowDir').style.display = runner === 'shell' || runner === 'n8shell' ? '' : 'none';
    $('schedHardNote').style.display = runner === 'notify' ? 'none' : '';
  }

  function openPanel() {
    const saved = ctx.state.noteId ? persist.findNote(ctx.state.noteId) : null;
    const s = saved && saved.schedule;
    if (s) {
      $('schedWhen').value = s.when || 'reminder';
      if (s.when === 'reminder') {
        $('schedDelay').value = s.delay || 10;
        $('schedUnit').value = s.unit || 'm';
      }
      if (s.when === 'at' && s.at) $('schedAt').value = s.at;
      if (s.when === 'cron') $('schedCron').value = s.cron || '';
      $('schedRunner').value = s.runner || 'notify';
      $('schedDir').value = s.dir || '';
      $('schedUnschedule').style.display = '';
      $('schedConfirm').textContent = 'Reschedule';
    } else {
      $('schedUnschedule').style.display = 'none';
      $('schedConfirm').textContent = 'Schedule';
      if (!$('schedAt').value) {
        const t = new Date(Date.now() + 3600000);
        $('schedAt').value = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }
    }
    syncRows();
    overlay.style.display = '';
  }
  function closePanel() {
    overlay.style.display = 'none';
  }

  if (scheduleBtn) {
    scheduleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPanel();
    });
  }
  $('schedCancel').addEventListener('click', closePanel);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePanel();
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') {
      e.preventDefault();
      closePanel();
    }
  });
  $('schedWhen').addEventListener('change', syncRows);
  $('schedRunner').addEventListener('change', syncRows);
  $('schedCronPreset').addEventListener('change', (e) => {
    if (e.target.value) $('schedCron').value = e.target.value;
  });
  $('schedPickDir').addEventListener('click', async () => {
    const dir = await ipc.invoke('sticky-pick-dir');
    if (dir) $('schedDir').value = dir;
  });
  $('schedConfirm').addEventListener('click', () => {
    const when = $('schedWhen').value;
    const runner = $('schedRunner').value;
    const sched = {
      when,
      runner,
      delay: Number($('schedDelay').value) || 10,
      unit: $('schedUnit').value,
      at: $('schedAt').value,
      cron: $('schedCron').value.trim(),
      dir: $('schedDir').value.trim(),
      created_at: new Date().toISOString()
    };
    ipc.send('sticky-schedule', ctx.state.noteId, sched);
    closePanel();
  });
  $('schedUnschedule').addEventListener('click', () => {
    ipc.send('sticky-unschedule', ctx.state.noteId);
    closePanel();
  });
}

module.exports = {start};
