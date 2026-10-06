import mongoose from 'mongoose';
import crypto from 'crypto';

const teamSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Please add a team name'],
        trim: true,
        maxlength: [50, 'Team name cannot be more than 50 characters']
    },
    description: {
        type: String,
        default: '',
        maxlength: [200, 'Description cannot exceed 200 characters']
    },
    logo: {
        type: String,
        default: ''
    },
    // The user who created this team (always a Team Lead)
    creator: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    // All members including the creator
    members: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        role: {
            type: String,
            enum: ['Team Lead', 'Contributor'],
            default: 'Contributor'
        },
        joinedAt: {
            type: Date,
            default: Date.now
        }
    }],
    // Unique code for others to join this team
    inviteCode: {
        type: String,
        unique: true
    },
    // Max team size for the free tier
    maxMembers: {
        type: Number,
        default: 10
    }
}, {
    timestamps: true
});

teamSchema.index({ 'members.user': 1 });
teamSchema.index({ creator: 1 });

// Generate a unique 8-char invite code before saving
teamSchema.pre('save', function (next) {
    if (!this.inviteCode) {
        this.inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    }
    next();
});

// Virtual: get member count
teamSchema.virtual('memberCount').get(function () {
    return this.members ? this.members.length : 0;
});

// Ensure virtuals are serialized
teamSchema.set('toJSON', { virtuals: true });
teamSchema.set('toObject', { virtuals: true });

export default mongoose.model('Team', teamSchema);
