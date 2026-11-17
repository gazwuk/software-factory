# Headless runner

Run factory jobs with no Claude Code session open: a Node process that takes jobs from
request to merge on its own, several at once, and picks up where it left off if it's
stopped or killed.
