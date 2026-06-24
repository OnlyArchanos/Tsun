const mongoose = require('mongoose');

const relationshipSchema = new mongoose.Schema({
    user1Id:    { type: String, required: true }, // lexicographically smaller
    user2Id:    { type: String, required: true }, // lexicographically larger
    status:     { type: String, enum: ['none', 'dating', 'married', 'enemies'], default: 'none' },
    initiatedBy: { type: String, default: null },
    confirmedAt: { type: Number, default: 0 },
    shipScore:  { type: Number, default: null },
    shipName:   { type: String, default: null },
    history: [{
        _id: false,
        event:     String,
        timestamp: Number,
        initiator: String,
        note:      String
    }],
    battleWins:       { type: Number, default: 0 },
    battleLosses:     { type: Number, default: 0 },
    lastProposalTime: { type: Number, default: 0 },
    lastShipBattle:   { type: Number, default: 0 },
    lastPositiveInteraction: { type: Number, default: 0 },
    lastNegativeInteraction: { type: Number, default: 0 },
    lastMilestoneCheck:      { type: Number, default: 0 }
});

relationshipSchema.index({ user1Id: 1, user2Id: 1 }, { unique: true });

module.exports = mongoose.model('Relationship', relationshipSchema);
