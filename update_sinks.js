const fs = require('fs');
const path = require('path');

const economyPath = path.join(__dirname, 'commands', 'economy.js');
let economyCode = fs.readFileSync(economyPath, 'utf8');

// 1. Gacha
economyCode = economyCode.replace(
    'const incFields = { coins: -totalCost, gachaBoxesOpened: pullCount, gachaTotalSpent: totalCost };',
    'const incFields = { coins: -totalCost, systemSpent: totalCost, gachaBoxesOpened: pullCount, gachaTotalSpent: totalCost };'
);

// 2. Taxes ({ $inc: { coins: -tax } })
economyCode = economyCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-tax\s*\}\s*\}/g,
    '{ $inc: { coins: -tax, systemSpent: tax } }'
);

// 3. Shop items with $inc: { coins: -cost }
economyCode = economyCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-cost\s*\}\s*\}/g,
    '{ $inc: { coins: -cost, systemSpent: cost } }'
);
economyCode = economyCode.replace(
    /\$inc:\s*\{\s*coins:\s*-cost\s*\}/g,
    '$inc: { coins: -cost, systemSpent: cost }'
);
// Fix overlapping replacements if any
economyCode = economyCode.replace(/systemSpent:\s*cost,\s*systemSpent:\s*cost/g, 'systemSpent: cost');

// 4. Shop items with other fields in $inc
economyCode = economyCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-cost\s*\},\s*\$set:/g,
    '{ $inc: { coins: -cost, systemSpent: cost }, $set:'
);
economyCode = economyCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-cost\s*\},\s*\$push:/g,
    '{ $inc: { coins: -cost, systemSpent: cost }, $push:'
);

// 5. Fishing Baits
economyCode = economyCode.replace(
    /const incOps = \{\s*coins:\s*-totalCost,/g,
    'const incOps = { coins: -totalCost, systemSpent: totalCost,'
);

// 6. Merchant Refresh
economyCode = economyCode.replace(
    /\$inc:\s*\{\s*coins:\s*-refreshCost\s*\}/g,
    '$inc: { coins: -refreshCost, systemSpent: refreshCost }'
);

// 7. Roulette
economyCode = economyCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-bet\s*\}\s*\}/g,
    '{ $inc: { coins: -bet, systemSpent: bet } }'
);
// In roulette win, return the systemSpent
economyCode = economyCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*bet\s*\}\s*\}/g,
    '{ $inc: { coins: bet, systemSpent: -bet } }'
);

// 8. Bounty Tax
economyCode = economyCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-amount\s*\}\s*\}/g,
    '{ $inc: { coins: -amount, systemSpent: tax } }'
);

fs.writeFileSync(economyPath, economyCode, 'utf8');
console.log('Updated economy.js');

// --- BATTLE.JS ---
const battlePath = path.join(__dirname, 'commands', 'battle.js');
let battleCode = fs.readFileSync(battlePath, 'utf8');

// Battle lost bet (Line 171) -> it's deducted on creation. We need to handle this properly. 
// Actually, !guess deductions
battleCode = battleCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-amount\s*\}\s*\}/g,
    '{ $inc: { coins: -amount, systemSpent: amount } }'
);
battleCode = battleCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*amount\s*\}\s*\}/g,
    '{ $inc: { coins: amount, systemSpent: -amount } }'
);

fs.writeFileSync(battlePath, battleCode, 'utf8');
console.log('Updated battle.js');

// --- FISHING.JS ---
const fishingPath = path.join(__dirname, 'commands', 'fishing.js');
let fishingCode = fs.readFileSync(fishingPath, 'utf8');

fishingCode = fishingCode.replace(
    /\$inc:\s*\{\s*coins:\s*-charterCost\s*\}/g,
    '$inc: { coins: -charterCost, systemSpent: charterCost }'
);
fishingCode = fishingCode.replace(
    /\$inc:\s*\{\s*coins:\s*-scaledCost\s*\}/g,
    '$inc: { coins: -scaledCost, systemSpent: scaledCost }'
);

fs.writeFileSync(fishingPath, fishingCode, 'utf8');
console.log('Updated fishing.js');

// --- SOCIAL.JS ---
const socialPath = path.join(__dirname, 'commands', 'social.js');
let socialCode = fs.readFileSync(socialPath, 'utf8');

socialCode = socialCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-cost\s*\}\s*\}/g,
    '{ $inc: { coins: -cost, systemSpent: cost } }'
);
socialCode = socialCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-targetCost\s*\}\s*\}/g,
    '{ $inc: { coins: -targetCost, systemSpent: targetCost } }'
);

fs.writeFileSync(socialPath, socialCode, 'utf8');
console.log('Updated social.js');

// --- HIGHERLOWER.JS ---
const hlPath = path.join(__dirname, 'commands', 'higherLower.js');
let hlCode = fs.readFileSync(hlPath, 'utf8');

hlCode = hlCode.replace(
    /\{\s*\$inc:\s*\{\s*coins:\s*-skipCost\s*\}\s*\}/g,
    '{ $inc: { coins: -skipCost, systemSpent: skipCost } }'
);

fs.writeFileSync(hlPath, hlCode, 'utf8');
console.log('Updated higherLower.js');

// --- INDEX.JS (Unwanted taxes/fees) ---
const indexPath = path.join(__dirname, 'index.js');
let indexCode = fs.readFileSync(indexPath, 'utf8');

indexCode = indexCode.replace(
    /\$inc:\s*\{\s*coins:\s*-500\s*\}/g,
    '$inc: { coins: -500, systemSpent: 500 }'
);

fs.writeFileSync(indexPath, indexCode, 'utf8');
console.log('Updated index.js');
