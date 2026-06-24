const mongoose = require('mongoose');

const electionSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    active: { type: Boolean, default: false },
    step: { type: Number, default: 0 }, // 0=Idle, 1=Purge, 2=Apply, 3=Vote/Tournament
    channelId: String,
    anchorMessageId: String,     // Persistent editable status embed
    messageId: String,           // Current active poll/button message
    candidates: [{
        _id: false,
        userId: String,
        displayName: String,
        speech: String,
        index: Number
    }],
    modCandidates: [{
        _id: false,
        index: Number,
        userId: String,
        displayName: String
    }],
    endTime: Number,
    processing: { type: Boolean, default: false },
    purgeResultText: String,     // Stores purge vote summary for final anchor

    // Tournament bracket system
    tournamentRound: { type: Number, default: 0 },
    tournamentBrackets: [{
        bracketIndex: Number,
        messageId: String,
        winnerUserId: String,
        candidates: [{
            _id: false,
            userId: String,
            displayName: String,
            index: Number
        }]
    }]
});

module.exports = mongoose.model('Election', electionSchema);