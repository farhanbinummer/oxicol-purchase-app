// rd-visibility.js - which R&D projects a person may open, as one SQL condition used by every list, count, sidebar entry and
// dashboard. Keeping it in one place means a count and the list it opens can never disagree.
//
//   - a draft: only the person who started it (and administrators)
//   - a submitted project: everyone holding rd.view_all, or someone holding rd.view who is the requester, the lead or a member
const { KEYS } = require('./permissions');
const { can } = require('./access');

/** Returns { clause, params }. The params are bound at $offset+1 .. $offset+4; the person's id is $offset+1. */
function visibleClause(access, userId, alias, offset) {
  const a = alias || 'p', o = offset || 0;
  const params = [userId, can(access, KEYS.RD_VIEW_ALL), can(access, KEYS.RD_VIEW), access.isAdmin];
  const [u, all, view, admin] = [1, 2, 3, 4].map(i => '$' + (o + i));
  const clause = `((${a}.is_draft = FALSE AND (${all} OR (${view} AND (${a}.requested_by_user = ${u} OR ${a}.lead_user_id = ${u}
      OR EXISTS (SELECT 1 FROM rd_project_members m WHERE m.project_id = ${a}.id AND m.user_id = ${u})))))
    OR (${a}.is_draft = TRUE AND (${a}.created_by = ${u} OR ${admin})))`;
  return { clause, params };
}

module.exports = { visibleClause };
