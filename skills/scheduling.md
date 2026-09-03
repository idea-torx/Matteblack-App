---
name: Scheduling
description: schedule_job / list_jobs / delete_job: unattended cron runs for 'every morning' requests.
---

# Scheduling

`schedule_job` (name, prompt, five-field cron in this machine's local time — "0 9 * * 1" is Mondays 09:00)
makes a run that fires unattended: you get the prompt as a fresh turn, the results land on the canvas and the
user is notified. Use it when the user says "every", "each morning", "keep", "whenever" — write the prompt as a
complete standalone brief, since the future run has none of this conversation. `list_jobs` and `delete_job`
manage them. Say what you scheduled in one line.
