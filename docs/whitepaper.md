# Gini Agent Whitepaper

OpenClaw gave us a glimpse of the future of autonomous AI agents by simply putting together a few memory files and a loop that takes initiative. It created moments of magic and a strange feeling of how it's different from a chatbot. But once you started actually depending on it, debugging the gateway after every update and teaching the claw agent to do the same task over and over became a full-time job. Hermes came along leaner, with fewer moving parts, and quietly pulled people across. Neither has closed the core gap: the agent stores facts about you, may or may not remember a caveat about a project, but doesn't reliably retrieve the way you'd expect a colleague to.

## What we're building 

A personal agent that can run without forcing you to read a log line. That's the bar. And when it does need you, reaching you should feel like a product asking a clear question — a control you act on in place, from wherever you are — not a log demanding to be read or a chat asking you to go do something else first.

## Gaps

These gaps are load-bearing today. More will surface as we build and as users tell us what's missing. Closing them is the difference between an agent that demos well and one that actually works.

**1. The agent remembers.** Talking to the agent should feel like talking to a colleague who has been working with you for a year. It knows the facts you've shared, the work you're doing, and why you're doing it. It surfaces relevant context without being asked. You don't tell it the same story twice, and you don't re-explain what you're trying to do.

The hard part is recall, not storage. Persisting text is solved. Deciding which facts matter for the current situation and bringing them in unprompted isn't. That's the problem users actually feel.

**2. What the agent learns, sticks.** Today's agents do a procedure once when you walk them through it. A week later, you're walking them through it again. That's not learning; that's a long autocomplete. The promise is the opposite: a thing you teach the agent today is a thing the agent owns next week. It runs the procedure on its own, judges whether the result was right, and when it wasn't, updates itself so the next run is better.

You don't read the agent's skills to decide whether they are usable. You rely on them because they've run before, against real situations, and worked.

**3. The interface is a product, not a chat log.** Current agents live inside messaging apps built for human conversation, so the surface is a flat history. You can't see what's queued, what's running, or what's waiting on you, and when the agent needs something from you it can only ask in prose — go add a key in settings, go to the machine to sign in, reply "yes" to send. The agent is running scheduled jobs and multi-step work, and the interface treats all of it as just more chat. Working with your agent should feel like using something designed for the job, not scrolling a thread.

So the interface earns two things. It shows the agent's real state — which tasks need your input, which are waiting on your review, which are running, which finished — instead of flattening all of it into more chat. And when the agent is stuck, it hands you the exact control to unblock it, in place: a secure field for a secret that never reaches the model, a sign-in or sensitive-step handoff into the agent's own browser, a set of choices when more than one path is reasonable, a confirm-before-it-goes-out in your name. No detour to a settings page, no pasting secrets into chat, no needing to be at the machine. Because every surface is a client of the same runtime, the same controls reach you on your phone as readily as the desktop — so the agent unblocks itself wherever you happen to be. Intuitive use isn't decoration here; it's how an agent that takes initiative stays answerable to you.

## Approach

Closing these requires two architectural choices the current frameworks haven't made. The runtime is local-first, so the agent doesn't depend on third-party uptime. And it's modular, so a fix to one piece doesn't break the others. Implementation lives in [architecture-overview.md](./architecture-overview.md).
