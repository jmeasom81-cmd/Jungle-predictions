# Game master contract
Use a server-side database connection and separate secret credentials for joining and game-master operations. No keys in the browser or Git.
 
- Publish only future episodes, with UK-local deadlines converted to exact ISO timestamps, clear questions, mutually exclusive answer options and objective resolution rules. 3–5 daily questions; special contests may run concurrently.
- Verify lineup, episode timing and outcomes against ITV or other reliable contemporaneous reporting. Each result requires source URL(s) and summary. No rumours, no guesses. If evidence is missing, keep pending. If a question is invalid, void with evidence and reason. Do not settle before lock.
- POST /api/game with action publish (admin bearer): {action,roundKey,title,category,opensAt,closesAt,questions:[{prompt,options,points,resolutionRule}]}. Repeated roundKey creates no duplicate.
- POST /api/game with action resolve (admin bearer): {action,questionId,status,answer,evidence:[{url,summary}]}. For void, omit answer. Settled questions are locked against silent overwrites.
- The leaderboard recalculates from settled questions; no repeated awarding of points.
- Player submissions are server-locked. Never disclose other players' choices before closing.
- Automation must be connected and tested before claiming the game runs itself. Recommended two passes: verify last episode and publish upcoming episode; monitor unresolved questions. If no confirmed episode, do not fabricate a round.
- No money stakes. Human owner retains responsibility for invitations and disputed results.
