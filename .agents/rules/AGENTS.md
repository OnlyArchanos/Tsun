    # Tsun Bot — Agent Instructions

## Stack
Node.js 18+, discord.js v14, MongoDB/Mongoose. No slash commands — text prefix only.

## Code conventions
- All income grants go through distributeIncome() in utils/income.js — never direct $inc on coins
- Nuggets always use direct $inc — never through distributeIncome
- All constants go in config.js — never hardcode values in command files
- Interaction IDs follow pattern: noun_verb_{dynamicId}
- Command files export: { handle(message, client), handleInteraction(interaction, client) }
- New command files must be imported and routed in index.js

## Bot personality
Tsundere anime girl. All user-facing strings use >///<, (¬_¬), baka. Never neutral tone.

## Rules
- Read every file before modifying it
- Only touch files the task mentions
- Do not refactor or rename existing code you weren't asked to change
- Match the exact code style of whichever file you're editing