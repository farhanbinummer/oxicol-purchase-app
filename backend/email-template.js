// email-template.js - the colourful, friendly HTML version of a notice. Pure functions, no database, easy to test.
// Everything from a person or a project is escaped; the plain-text version is always sent too (for mail apps that show text only).
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Each kind of notice gets a colour, an emoji, a short positive headline and an encouraging closing line.
const KINDS = {
  task_assigned: { color: '#0f766e', soft: '#ccfbf1', emoji: '🎯', head: 'A new task is on your way!', cheer: 'You have got this. Small steps, great results!' },
  task_review: { color: '#4f46e5', soft: '#e0e7ff', emoji: '🔍', head: 'Great work is waiting for you', cheer: 'A quick, kind review helps the whole team shine.' },
  task_done: { color: '#16a34a', soft: '#dcfce7', emoji: '✅', head: 'One more task done!', cheer: 'Progress feels good. Keep the momentum going!' },
  task_accepted: { color: '#16a34a', soft: '#dcfce7', emoji: '🎉', head: 'Well done, your work was accepted!', cheer: 'Thank you for the effort. It makes a real difference.' },
  task_sent_back: { color: '#d97706', soft: '#fef3c7', emoji: '💡', head: 'Almost there, a small tweak is needed', cheer: 'Every great result has a polish step. You are close!' },
  task_reopened: { color: '#d97706', soft: '#fef3c7', emoji: '🔄', head: 'A task needs another look', cheer: 'A fresh pass will make it even better.' },
  task_cancelled: { color: '#64748b', soft: '#f1f5f9', emoji: '📌', head: 'A task was set aside', cheer: 'Thanks for your flexibility. On to the next good thing!' },
  request: { color: '#0891b2', soft: '#cffafe', emoji: '🚀', head: 'A new R&D request has arrived!', cheer: 'New ideas keep us growing. Let us make it happen!' },
  stage: { color: '#7c3aed', soft: '#ede9fe', emoji: '🏁', head: 'A project stage is complete!', cheer: 'Another milestone reached. Congratulations, team!' },
  project: { color: '#16a34a', soft: '#dcfce7', emoji: '🏆', head: 'A project is complete!', cheer: 'What a result. Thank you to everyone who made it happen!' },
  cover_request: { color: '#0f766e', soft: '#ccfbf1', emoji: '🤝', head: 'A colleague is counting on you', cheer: 'Thank you for helping the team keep moving!' },
  cover_response: { color: '#2563eb', soft: '#dbeafe', emoji: '📅', head: 'An update on cover while someone is away', cheer: 'Good planning keeps the work flowing. Thank you!' },
  trial_added: { color: '#7c3aed', soft: '#ede9fe', emoji: '🧪', head: 'A new lab trial is on record!', cheer: 'Every trial brings the right formula closer. Great work, team!' },
  trial_preferred: { color: '#16a34a', soft: '#dcfce7', emoji: '⭐', head: 'A preferred formula has been chosen!', cheer: 'What a milestone. Thank you to everyone in the lab!' },
  morning: { color: '#ea580c', soft: '#ffedd5', emoji: '☀️', head: 'Good morning! Here is your plan for the day', cheer: 'Take it one task at a time. You will do wonderfully today!' }
};
const DEFAULT_KIND = { color: '#0f766e', soft: '#ccfbf1', emoji: '👋', head: 'A quick note from Oxicol', cheer: 'Thank you for all you do!' };
const SECTION_COLORS = { 'Sent back to you': '#d97706', 'Covering for a colleague who is away': '#7c3aed', 'Lab trials to record': '#7c3aed', 'Please confirm you can cover (open Away and cover)': '#0f766e', 'Absences waiting for your approval (open Away and cover)': '#2563eb', 'Waiting for your review': '#4f46e5', 'Overdue': '#dc2626', 'Due today': '#ea580c', 'Due tomorrow': '#0f766e' };

/** Turns the plain text of a notice into HTML paragraphs; lines starting with "  - " become list items, "Title:" lines become headings. */
function bodyHtml(text, color) {
  const blocks = String(text).split(/\n{2,}/);
  return blocks.map(block => {
    const lines = block.split('\n');
    const first = lines[0].trim();
    const isList = lines.slice(1).some(l => /^\s+-\s/.test(l)) || /^\s+-\s/.test(lines[0]);
    if (isList || /:$/.test(first)) {
      const title = /:$/.test(first) ? first.replace(/:$/, '') : '';
      const items = lines.filter(l => /^\s+-\s/.test(l)).map(l => l.replace(/^\s+-\s/, ''));
      const more = lines.filter(l => /^\s+\.\.\./.test(l)).map(l => l.trim());
      const c = SECTION_COLORS[title] || color;
      return `<div style="margin:18px 0 6px;font-weight:700;color:${c};font-size:15px">${esc(title)}</div>` +
        `<ul style="margin:0;padding:0 0 0 20px;color:#334155;font-size:15px;line-height:1.6">${items.map(i => `<li style="margin:4px 0">${esc(i)}</li>`).join('')}${more.map(m => `<li style="list-style:none;color:#64748b">${esc(m)}</li>`).join('')}</ul>`;
    }
    return `<p style="margin:0 0 14px;color:#334155;font-size:16px;line-height:1.6">${esc(block).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

/** { html, text } for one notice. `link` is the full address or ''. */
function renderEmail({ kind, name, text, link }) {
  const k = KINDS[kind] || DEFAULT_KIND;
  const first = String(name || '').split(' ')[0] || 'there';
  const button = link ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px"><tr><td style="background:${k.color};border-radius:10px"><a href="${esc(link)}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-weight:700;font-size:16px;text-decoration:none;font-family:Arial,Helvetica,sans-serif">Open in Oxicol &rarr;</a></td></tr></table>` : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
<tr><td style="background:${k.color};background-image:linear-gradient(135deg,${k.color},#0f172a);padding:28px 28px 22px;color:#ffffff">
<div style="font-size:13px;letter-spacing:2px;font-weight:700;opacity:.85">OXICOL</div>
<div style="font-size:44px;line-height:1.1;margin:10px 0 6px">${k.emoji}</div>
<div style="font-size:23px;font-weight:700;line-height:1.3">${esc(k.head)}</div></td></tr>
<tr><td style="padding:26px 28px 8px">
<p style="margin:0 0 16px;font-size:18px;color:#0f172a"><b>Hi ${esc(first)},</b></p>
${bodyHtml(text, k.color)}${button}</td></tr>
<tr><td style="padding:8px 28px 26px"><div style="background:${k.soft};border-radius:12px;padding:14px 16px;color:#1e293b;font-size:15px;line-height:1.5">✨ ${esc(k.cheer)}</div></td></tr>
<tr><td style="background:#f8fafc;padding:16px 28px;color:#94a3b8;font-size:12px;line-height:1.5">Sent by the Oxicol Purchase App. You can change which notices you get under My Account &rarr; Notices.</td></tr>
</table></td></tr></table></body></html>`;
  const plain = `Hi ${first},\n\n${k.head}\n\n${text}${link ? `\n\nOpen in Oxicol: ${link}` : ''}\n\n${k.cheer}\n\n- Oxicol`;
  return { html, text: plain };
}

module.exports = { renderEmail, KINDS, esc };
