const mongoose = require('mongoose');

const loanSchema = new mongoose.Schema({
    lenderId: { type: String, required: true },
    borrowerId: { type: String, required: true },
    
    // Financials
    initialAmount: { type: Number, required: true },
    remainingAmount: { type: Number, required: true },
    interestRate: { type: Number, required: true }, // 1-20
    totalRepayment: { type: Number, required: true },
    
    // Timing
    dueDate: { type: Number, required: true }, // Timestamp
    
    // State
    status: { 
        type: String, 
        enum: ['ACTIVE', 'PAID', 'DEFAULTED'], 
        default: 'ACTIVE' 
    }
});

// Compound index to quickly check if a user already has an active loan (as borrower or lender)
loanSchema.index({ borrowerId: 1, status: 1 });
loanSchema.index({ lenderId: 1, status: 1 });
loanSchema.index({ status: 1, dueDate: 1 });

module.exports = mongoose.model('Loan', loanSchema);