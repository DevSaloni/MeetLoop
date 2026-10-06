import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema({
    description: {
        type: String,
        required: true,
        trim: true
    },
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    dueDate: {
        type: Date,
        default: null
    },
    priority: {
        type: String,
        enum: ['HIGH', 'MEDIUM', 'LOW'],
        default: 'MEDIUM'
    },
    status: {
        type: String,
        enum: ['open', 'done', 'blocked', 'overdue'],
        default: 'open'
    }
});

const decisionSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        default: '',
        trim: true
    }
});

const meetingSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Meeting title is required'],
        trim: true,
        maxlength: [100, 'Title cannot exceed 100 characters']
    },
    description: {
        type: String,
        default: '',
        trim: true
    },
    team: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Team',
        required: [true, 'Meeting must belong to a team']
    },
    date: {
        type: Date,
        required: [true, 'Meeting date is required']
    },
    meetingType: {
        type: String,
        enum: [
            'Sprint Planning',
            'Daily Standup',
            'Backlog Refinement',
            'Sprint Review',
            'Sprint Retrospective',
            'Strategy & Planning',
            'Technical Architecture',
            'Client Meeting',
            '1-on-1 Sync',
            'Other'
        ],
        default: 'Other'
    },
    notes: {
        type: String,
        default: ''
    },
    summary: {
        type: String,
        default: ''
    },
    tasks: [taskSchema],
    decisions: [decisionSchema],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    aiProcessed: {
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

meetingSchema.index({ team: 1, date: -1 });
meetingSchema.index({ 'tasks.assignedTo': 1 });
meetingSchema.index({ createdBy: 1 });

// Virtual: task stats
meetingSchema.virtual('taskStats').get(function () {
    const total = this.tasks.length;
    const done = this.tasks.filter(t => t.status === 'done').length;
    const open = this.tasks.filter(t => t.status === 'open').length;
    const overdue = this.tasks.filter(t => t.status === 'overdue').length;
    const blocked = this.tasks.filter(t => t.status === 'blocked').length;
    return { total, done, open, overdue, blocked };
});

meetingSchema.set('toJSON', { virtuals: true });
meetingSchema.set('toObject', { virtuals: true });

export default mongoose.model('Meeting', meetingSchema);
