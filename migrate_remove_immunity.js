/**
 * Migration: Remove Immunity Badge & Compensate Holders
 * 
 * Finds all users with immunityBadge > 0 (or === true for legacy),
 * gives them 10 nuggets as compensation, then $unset the field from ALL documents.
 * 
 * Usage:
 *   node migrate_remove_immunity.js
 * 
 * Requires: MONGO_URI in .env (same as the bot uses)
 */

require('dotenv').config();
const mongoose = require('mongoose');

const COMPENSATION_NUGGETS = 10;

async function run() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('❌ MONGO_URI not found in .env');
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');

    // --- Step 1: Find holders (immunityBadge > 0 or === true) ---
    const holders = await usersCollection.find({
        $or: [
            { immunityBadge: { $gt: 0 } },
            { immunityBadge: true }
        ]
    }).project({ userId: 1, immunityBadge: 1, nuggets: 1 }).toArray();

    console.log(`\n🔍 Found ${holders.length} user(s) with active Immunity Badge:\n`);

    for (const h of holders) {
        const seasons = h.immunityBadge === true ? 3 : h.immunityBadge;
        console.log(`  • userId: ${h.userId} | seasons remaining: ${seasons} | current nuggets: ${h.nuggets ?? 0}`);
    }

    // --- Step 2: Compensate holders (+10 nuggets) ---
    if (holders.length > 0) {
        const holderFilter = {
            $or: [
                { immunityBadge: { $gt: 0 } },
                { immunityBadge: true }
            ]
        };

        const compensateResult = await usersCollection.updateMany(
            holderFilter,
            { $inc: { nuggets: COMPENSATION_NUGGETS } }
        );

        console.log(`\n💎 Compensated ${compensateResult.modifiedCount} holder(s) with ${COMPENSATION_NUGGETS} nuggets each.`);
    } else {
        console.log('\n💎 No holders to compensate.');
    }

    // --- Step 3: $unset immunityBadge from ALL documents ---
    const unsetResult = await usersCollection.updateMany(
        { immunityBadge: { $exists: true } },
        { $unset: { immunityBadge: '' } }
    );

    console.log(`🧹 Removed immunityBadge field from ${unsetResult.modifiedCount} document(s).`);

    // --- Step 4: Verify ---
    const remaining = await usersCollection.countDocuments({ immunityBadge: { $exists: true } });
    if (remaining === 0) {
        console.log('\n✅ Verification passed: 0 documents still have immunityBadge.');
    } else {
        console.error(`\n❌ Verification FAILED: ${remaining} document(s) still have immunityBadge!`);
    }

    await mongoose.disconnect();
    console.log('\n✅ Done. Disconnected.');
}

run().catch(err => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});
