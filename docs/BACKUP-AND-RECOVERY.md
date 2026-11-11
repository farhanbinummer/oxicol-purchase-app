# Backup and recovery

Your data lives in one PostgreSQL database. If it is lost or damaged, everything is lost: projects, results, users, purchase orders. **The app code is safe on GitHub; the data is not unless you back it up.**

I (the developer assistant) cannot see your hosting account or database, so I have not been able to check any of this for you. Please confirm each point yourself.

## 1. Find out what you have today

- [ ] Where is the database hosted? (Your notes mention Supabase; the app runs on Render. Check which account holds the **database**.)
- [ ] Does that provider make **automatic backups**, how often, and how many days are kept? Free plans often keep few or none, and may pause the database when unused.
- [ ] Can you **restore** from one, and have you ever tried?

## 2. Take your own backup (works anywhere)

You need the database connection string. On Render it is the `DATABASE_URL` environment variable of the service; on Supabase it is under Project Settings > Database. On your own computer with PostgreSQL tools installed:

```bash
pg_dump "YOUR_DATABASE_URL" --no-owner --format=custom --file=oxicol-backup-$(date +%F).dump
```

Keep the file somewhere other than the same account (your computer plus a cloud drive). Never put it on GitHub: it contains people's data and password hashes.

## 3. Practise a restore (important: a backup you have never restored is only a hope)

Restore into a **new, empty test database**, never into the live one:

```bash
createdb oxicol_restore_test
pg_restore --no-owner --dbname=oxicol_restore_test oxicol-backup-YYYY-MM-DD.dump
psql oxicol_restore_test -c "select count(*) from users; select count(*) from rd_projects;"
```

If the counts look right, the backup is good. Delete the test database afterwards.

## 4. When to take a backup

- **Before every deploy that contains a database change** (the Render log shows `Migration applied` lines). Recent ones added R&D tasks, forms, review, passwords.
- **Weekly** at least, once real people are using the app.
- **Before deleting or merging anything in bulk.**

## 5. If something goes wrong after a deploy

1. Do not keep clicking. Note the time and the error.
2. In Render, roll the service back to the previous deploy (Deploys > the earlier one > Rollback). This restores the old *code*; it does **not** undo database changes, which only add columns and tables and do not delete data.
3. If data is damaged, restore the latest backup into a test database first, check it, then decide with the developer how to bring the missing data back.

## 6. Other safety points

- Keep the administrator password in a password manager, and have **two** administrators so nobody is locked out.
- Passwords are stored only as hashes, so they cannot be read back. A forgotten password is reset by an administrator.
- A server that is rebuilt from this repository now starts with the standard permissions (a one-time step for brand-new databases only). Your existing permission settings are never changed by it.
