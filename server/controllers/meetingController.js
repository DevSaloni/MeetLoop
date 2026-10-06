import Meeting from '../models/Meeting.js';
import Team from '../models/Team.js';
import { sendNotification } from '../utils/notificationHelper.js';
import { io } from '../index.js';
import {
    cacheGetOrSet,
    invalidateMeeting,
    invalidateTeam,
    keys,
    TTL,
    toPlain
} from '../utils/cache.js';

const bustMeetingCaches = async (meeting) => {
    await invalidateMeeting(meeting);
    const teamId = meeting.team?._id || meeting.team;
    if (!teamId) return;
    const team = await Team.findById(teamId).select('_id members inviteCode');
    if (team) await invalidateTeam(team);
};

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

/**
 * AI Extraction Helper
 * Extracts tasks and decisions from meeting notes using Google Gemini AI.
 * Includes robust model rotation and retry logic for quota limits.
 */
const extractWithAI = async (notes, teamMembers, currentUserName = null, currentUserId = null) => {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey || apiKey.includes('YOUR_GEMINI_API_KEY')) {
            console.error('AI EXTRACTION ERROR: Valid GEMINI_API_KEY not found in .env file');
            return { tasks: [], decisions: [] };
        }

        const genAI = new GoogleGenerativeAI(apiKey);

        // List of models to try in order of preference
        // We include both explicit names and aliases like 'latest'
        const modelsToTry = [
            'gemini-3.8-flash',
            'gemini-2.0-flash',
            'gemini-flash-latest',
            'gemini-pro-latest',
            'gemini-1.5-pro'
        ];

        const memberList = teamMembers
            .filter(m => m.name && m.id)
            .map(m => `- ${m.name} (Email: ${m.email || 'N/A'}, Role: ${m.role || 'Member'}, ID: ${m.id})`)
            .join('\n');

        const today = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        const prompt = `You are an AI assistant for a meeting accountability platform called MeetLoop.
Today is ${today}.
${(currentUserName && currentUserId) ? `The Team Leader, who is also the person speaking or writing these notes ("me", "I", "myself"), is: **${currentUserName}** (ID: ${currentUserId}).` : ''}

Analyze the following meeting notes and extract:
1. **Tasks/Commitments** — Any action items, assignments, or promises made by team members.
2. **Decisions** — Any strategic or operational decisions agreed upon.

Here are the team members who could be assigned tasks:
${memberList}

MEETING NOTES:
"""
${notes}
"""

Respond in this exact JSON format:
{
  "summary": "A 2-3 sentence high-level overview of the meeting and its main goal",
  "tasks": [
    {
      "description": "Clear description of the task",
      "assignedTo": "the member ID from the list above, or null if unclear",
      "assignedToName": "member name or 'Unassigned'",
      "dueDate": "YYYY-MM-DD format or null if not mentioned",
      "priority": "HIGH or MEDIUM or LOW"
    }
  ],
  "decisions": [
    {
      "title": "Short title of the decision",
      "description": "Detailed description of what was decided"
    }
  ]
}

Rules:
- **Analyze Dense Paragraphs**: Even if the notes are written as a messy paragraph, carefully extract every implied commitment or decision.
- **Handle Duplicate Names**: Use the provided Email and Role to distinguish between members with similar names. 
- **Match Names Intelligently**: Match nicknames (e.g. "Salu") to the closest name in the list.
- **Identify "Me/I/Team Leader"**: If the notes refer to "me", "I", "myself", or "team leader", assign the task to ID: **${currentUserId || 'null'}**.
- **Date Conversion**: Convert relative dates (e.g. "tomorrow", "by Friday") to absolute YYYY-MM-DD format based on today's date (${today}).
- Return ONLY valid JSON. If no tasks/decisions found, return empty arrays.`;

        let result = null;
        let lastError = null;

        for (const modelName of modelsToTry) {
            try {
                console.log(`Attempting AI extraction with model: ${modelName}...`);
                const model = genAI.getGenerativeModel({ model: modelName });
                result = await model.generateContent(prompt);

                if (result && result.response) {
                    console.log(`✅ AI extraction successful with model: ${modelName}`);
                    break;
                }
            } catch (err) {
                lastError = err;
                console.warn(`⚠️ Model ${modelName} failed:`, err.message);

                // If it's a quota error (429) or model not found (404), try the next one immediately
                if (err.message.includes('429') || err.message.includes('404')) {
                    continue;
                } else {
                    // For other errors, maybe break? No, let's try them all.
                    continue;
                }
            }
        }

        if (!result) {
            throw lastError || new Error('All configured AI models failed to respond.');
        }

        const responseText = result.response.text();

        // Robust JSON cleaning
        let cleanJson = responseText.trim();
        const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            cleanJson = jsonMatch[0];
        }

        try {
            const parsed = JSON.parse(cleanJson);
            return {
                summary: parsed.summary || '',
                tasks: (Array.isArray(parsed.tasks) ? parsed.tasks : []).map(t => ({
                    description: t.description || '',
                    assignedTo: t.assignedTo || t.assignedToId || null,
                    dueDate: t.dueDate || null,
                    priority: t.priority || 'MEDIUM'
                })),
                decisions: Array.isArray(parsed.decisions) ? parsed.decisions : []
            };
        } catch (parseError) {
            console.error('AI JSON Parse Error:', parseError.message);
            return { summary: '', tasks: [], decisions: [] };
        }
    } catch (error) {
        console.error('AI EXTRACTION FAILED AFTER ALL ATTEMPTS:', error.message);
        return { summary: '', tasks: [], decisions: [] };
    }
};


// ── @desc    Create a meeting ──────────────────────────────────────────
// ── @route   POST /api/meetings ────────────────────────────────────────
// ── @access  Team Lead only ────────────────────────────────────────────
export const createMeeting = async (req, res) => {
    try {
        const { title, teamId, date, meetingType, notes } = req.body;

        if (!title || !teamId || !date) {
            return res.status(400).json({ message: 'Title, team, and date are required' });
        }

        if (req.user.role !== 'Team Lead') {
            return res.status(403).json({ message: 'Only Team Leads can create meetings' });
        }

        const team = await Team.findById(teamId).populate('members.user', 'name email profilePic');
        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        const isMember = team.members.some(m => m.user && m.user._id.toString() === req.user._id.toString());
        if (!isMember) {
            return res.status(403).json({ message: 'You are not a member of this team' });
        }

        const meeting = new Meeting({
            title,
            team: teamId,
            date,
            meetingType: meetingType || 'Other',
            notes: notes || '',
            createdBy: req.user._id,
            aiProcessed: false,
            tasks: [],
            decisions: []
        });

        // If tasks and decisions are provided directly (preview confirm), use them
        if (req.body.tasks) {
            meeting.tasks = req.body.tasks.map(t => ({
                ...t,
                assignedTo: (t.assignedTo && t.assignedTo !== '') ? t.assignedTo : null,
                status: t.status || 'open'
            }));
            meeting.aiProcessed = true;
        }

        if (req.body.decisions) {
            meeting.decisions = req.body.decisions;
        }

        // Otherwise, if only notes are provided, run AI extraction (legacy or direct flow)
        if (!req.body.tasks && notes && notes.trim().length > 20) {
            const teamMembers = team.members
                .filter(m => m.user)
                .map(m => ({
                    id: m.user._id.toString(),
                    name: m.user.name,
                    email: m.user.email,
                    role: m.role
                }));

            const aiResult = await extractWithAI(notes, teamMembers, req.user.name, req.user._id);

            meeting.summary = aiResult.summary || '';

            if (aiResult.tasks && aiResult.tasks.length > 0) {
                meeting.tasks = aiResult.tasks.map(t => {
                    const isValidObjectId = t.assignedTo && /^[0-9a-fA-F]{24}$/.test(t.assignedTo);
                    let dueDate = null;
                    if (t.dueDate) {
                        const d = new Date(t.dueDate);
                        if (!isNaN(d.getTime())) dueDate = d;
                    }
                    return {
                        description: t.description || 'No description',
                        assignedTo: isValidObjectId ? t.assignedTo : null,
                        dueDate: dueDate,
                        priority: ['HIGH', 'MEDIUM', 'LOW'].includes(t.priority) ? t.priority : 'MEDIUM',
                        status: 'open'
                    };
                });
            }

            if (aiResult.decisions && aiResult.decisions.length > 0) {
                meeting.decisions = aiResult.decisions.map(d => ({
                    title: d.title || 'Decision',
                    description: d.description || ''
                }));
            }

            meeting.aiProcessed = true;
        }

        await meeting.save();

        await invalidateTeam(team);
        await invalidateMeeting(meeting);

        // ── Real-time Notifications for Tasks ──────────────────────────
        if (meeting.tasks && meeting.tasks.length > 0) {
            meeting.tasks.forEach(task => {
                if (task.assignedTo) {
                    sendNotification({
                        recipient: task.assignedTo,
                        sender: req.user._id,
                        type: 'TASK_ASSIGNED',
                        title: 'New Task Assigned',
                        message: `You were assigned a task in "${meeting.title}": ${task.description}`,
                        link: `/app/meetings/${meeting._id}`
                    });
                }
            });
        }

        const populatedMeeting = await Meeting.findById(meeting._id)
            .populate('team', 'name logo')
            .populate('createdBy', 'name email profilePic')
            .populate('tasks.assignedTo', 'name email profilePic');

        res.status(201).json(populatedMeeting);
    } catch (error) {
        console.error('Create Meeting Error:', error);
        res.status(500).json({ message: error.message || 'Server error creating meeting' });
    }
};

// ── @desc    Get all meetings for user's teams ─────────────────────────
// ── @route   GET /api/meetings ─────────────────────────────────────────
// ── @access  Private ───────────────────────────────────────────────────
export const getMyMeetings = async (req, res) => {
    try {
        const meetings = await cacheGetOrSet(
            keys.meetingsByUser(req.user._id),
            TTL.MEETINGS_LIST,
            async () => {
                const teams = await Team.find({
                    'members.user': req.user._id
                }).select('_id');

                const teamIds = teams.map(t => t._id);

                const docs = await Meeting.find({ team: { $in: teamIds } })
                    .populate('team', 'name logo')
                    .populate('createdBy', 'name email profilePic')
                    .populate('tasks.assignedTo', 'name email profilePic')
                    .sort({ date: -1 });

                return toPlain(docs);
            }
        );

        res.json(meetings);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ── @desc    Get single meeting ────────────────────────────────────────
// ── @route   GET /api/meetings/:id ─────────────────────────────────────
// ── @access  Private ───────────────────────────────────────────────────
export const getMeetingById = async (req, res) => {
    try {
        const meeting = await cacheGetOrSet(
            keys.meeting(req.params.id),
            TTL.MEETING,
            async () => {
                const doc = await Meeting.findById(req.params.id)
                    .populate('team', 'name logo members')
                    .populate('createdBy', 'name email profilePic')
                    .populate('tasks.assignedTo', 'name email profilePic');
                return doc ? toPlain(doc) : null;
            }
        );

        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }

        const teamId = meeting.team?._id || meeting.team;
        const team = meeting.team?.members
            ? meeting.team
            : await Team.findById(teamId);
        const isMember = team?.members?.some(m => {
            const uid = m.user?._id || m.user;
            return uid && uid.toString() === req.user._id.toString();
        });
        if (!isMember) {
            return res.status(403).json({ message: 'Access denied' });
        }

        res.json(meeting);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ── @desc    Update a meeting ──────────────────────────────────────────
// ── @route   PUT /api/meetings/:id ─────────────────────────────────────
// ── @access  Team Lead (creator) only ──────────────────────────────────
export const updateMeeting = async (req, res) => {
    try {
        const meeting = await Meeting.findById(req.params.id);
        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }

        if (meeting.createdBy.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Only the meeting creator can edit' });
        }

        const { title, date, meetingType, notes, tasks, decisions } = req.body;

        if (title) meeting.title = title;
        if (date) meeting.date = date;
        if (meetingType) meeting.meetingType = meetingType;
        if (notes !== undefined) meeting.notes = notes;

        if (tasks) {
            meeting.tasks = tasks.map(t => ({
                ...t,
                assignedTo: (t.assignedTo && t.assignedTo !== '') ? t.assignedTo : null
            }));
        }

        if (decisions) meeting.decisions = decisions;

        await meeting.save();

        const populated = await Meeting.findById(meeting._id)
            .populate('team', 'name logo')
            .populate('createdBy', 'name email profilePic')
            .populate('tasks.assignedTo', 'name email profilePic');

        if (io) {
            io.to(`meeting_${meeting._id}`).emit('meeting_update', populated);
            io.to(`team_${meeting.team._id || meeting.team}`).emit('meeting_list_update');
        }

        await bustMeetingCaches(populated);

        res.json(populated);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ── @desc    Delete a meeting ──────────────────────────────────────────
// ── @route   DELETE /api/meetings/:id ──────────────────────────────────
// ── @access  Team Lead (creator) only ──────────────────────────────────
export const deleteMeeting = async (req, res) => {
    try {
        const meeting = await Meeting.findById(req.params.id);
        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }

        if (meeting.createdBy.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Only the meeting creator can delete' });
        }

        await meeting.deleteOne();
        await invalidateMeeting(meeting);
        const team = await Team.findById(meeting.team).select('_id members inviteCode');
        if (team) await invalidateTeam(team);
        res.json({ message: 'Meeting deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ── @desc    Extract tasks from text without saving ──────────────────
// ── @route   POST /api/meetings/extract-preview ──────────────────────
// ── @access  Team Lead only ──────────────────────────────────────────
export const extractOnly = async (req, res) => {
    try {
        const { notes, teamId } = req.body;
        if (!notes || !teamId) {
            return res.status(400).json({ message: 'Notes and teamId are required' });
        }

        const team = await Team.findById(teamId).populate('members.user', 'name email');
        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        const teamMembers = team.members
            .filter(m => m.user)
            .map(m => ({
                id: m.user._id.toString(),
                name: m.user.name,
                email: m.user.email,
                role: m.role
            }));

        const aiResult = await extractWithAI(notes, teamMembers, req.user.name, req.user._id);
        res.json(aiResult);
    } catch (error) {
        console.error('Extract Preview Error:', error);
        res.status(500).json({ message: error.message || 'AI extraction failed' });
    }
};

// ── @desc    Re-run AI extraction on existing notes ────────────────────
// ── @route   POST /api/meetings/:id/extract ────────────────────────────
// ── @access  Team Lead (creator) only ──────────────────────────────────
export const reExtractTasks = async (req, res) => {
    try {
        const meeting = await Meeting.findById(req.params.id);
        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }

        if (meeting.createdBy.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Only the creator can re-extract' });
        }

        if (!meeting.notes || meeting.notes.trim().length < 20) {
            return res.status(400).json({ message: 'Notes are too short for extraction' });
        }

        const team = await Team.findById(meeting.team).populate('members.user', 'name email');
        const teamMembers = team.members
            .filter(m => m.user)
            .map(m => ({
                id: m.user._id.toString(),
                name: m.user.name,
                email: m.user.email,
                role: m.role
            }));

        const aiResult = await extractWithAI(meeting.notes, teamMembers, req.user.name, req.user._id);

        meeting.summary = aiResult.summary || '';

        if (aiResult.tasks && aiResult.tasks.length > 0) {
            // Build a rich map of existing tasks for multi-strategy matching
            const existingTasks = meeting.tasks.map(task => ({
                description: task.description,
                descLower: task.description.toLowerCase().trim(),
                descWords: new Set(task.description.toLowerCase().trim().split(/\s+/).filter(w => w.length > 3)),
                status: task.status,
                assignedTo: task.assignedTo?.toString() || null,
                dueDate: task.dueDate,
                priority: task.priority,
                matched: false
            }));

            // Helper: calculate word overlap score between two descriptions
            const similarityScore = (words1, words2) => {
                if (words1.size === 0 || words2.size === 0) return 0;
                let overlap = 0;
                words1.forEach(w => { if (words2.has(w)) overlap++; });
                return overlap / Math.max(words1.size, words2.size);
            };

            meeting.tasks = aiResult.tasks.map(t => {
                const isValidObjectId = t.assignedTo && /^[0-9a-fA-F]{24}$/.test(t.assignedTo);
                const desc = t.description || 'No description';
                const descLower = desc.toLowerCase().trim();
                const descWords = new Set(descLower.split(/\s+/).filter(w => w.length > 3));

                let matchedExisting = null;

                // Strategy 1: Exact description match
                matchedExisting = existingTasks.find(et => !et.matched && et.descLower === descLower);

                // Strategy 2: High word-overlap similarity (>= 50%)
                if (!matchedExisting) {
                    let bestScore = 0;
                    let bestMatch = null;
                    existingTasks.forEach(et => {
                        if (et.matched) return;
                        const score = similarityScore(descWords, et.descWords);
                        if (score > bestScore && score >= 0.5) {
                            bestScore = score;
                            bestMatch = et;
                        }
                    });
                    matchedExisting = bestMatch;
                }

                // Strategy 3: Same assignee with partial keyword overlap (>= 30%)
                if (!matchedExisting && isValidObjectId) {
                    let bestScore = 0;
                    let bestMatch = null;
                    existingTasks.forEach(et => {
                        if (et.matched) return;
                        if (et.assignedTo === t.assignedToId) {
                            const score = similarityScore(descWords, et.descWords);
                            if (score > bestScore && score >= 0.3) {
                                bestScore = score;
                                bestMatch = et;
                            }
                        }
                    });
                    matchedExisting = bestMatch;
                }

                // Mark matched to prevent double-matching
                if (matchedExisting) matchedExisting.matched = true;

                return {
                    description: desc,
                    assignedTo: isValidObjectId ? t.assignedTo : (matchedExisting?.assignedTo || null),
                    dueDate: t.dueDate ? new Date(t.dueDate) : (matchedExisting?.dueDate || null),
                    priority: t.priority || (matchedExisting?.priority || 'MEDIUM'),
                    status: matchedExisting?.status || 'open'
                };
            });
        }

        if (aiResult.decisions && aiResult.decisions.length > 0) {
            meeting.decisions = aiResult.decisions.map(d => ({
                title: d.title || 'Decision',
                description: d.description || ''
            }));
        }

        meeting.aiProcessed = true;
        await meeting.save();

        // ── Notify newly assigned tasks ──────────────────────────────
        if (meeting.tasks && meeting.tasks.length > 0) {
            meeting.tasks.forEach(task => {
                if (task.assignedTo) {
                    sendNotification({
                        recipient: task.assignedTo,
                        sender: req.user._id,
                        type: 'TASK_ASSIGNED',
                        title: 'Task Assignment Update',
                        message: `Task assignment updated in "${meeting.title}": ${task.description}`,
                        link: `/app/meetings/${meeting._id}`
                    });
                }
            });
        }

        const populated = await Meeting.findById(meeting._id)
            .populate('team', 'name logo')
            .populate('createdBy', 'name email profilePic')
            .populate('tasks.assignedTo', 'name email profilePic');

        if (io) {
            io.to(`meeting_${meeting._id}`).emit('meeting_update', populated);
            io.to(`team_${meeting.team._id || meeting.team}`).emit('meeting_list_update');
        }

        await bustMeetingCaches(populated);

        res.json(populated);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ── @desc    Update a single task status ───────────────────────────────
// ── @route   PUT /api/meetings/:id/tasks/:taskId ───────────────────────
// ── @access  Private (assigned user or creator) ────────────────────────
export const updateTaskStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const meeting = await Meeting.findById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }

        const task = meeting.tasks.id(req.params.taskId);
        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        const isCreator = meeting.createdBy.toString() === req.user._id.toString();
        const isAssignee = task.assignedTo && task.assignedTo.toString() === req.user._id.toString();

        if (!isCreator && !isAssignee) {
            return res.status(403).json({ message: 'You can only update your own tasks' });
        }

        if (status) task.status = status;

        if (req.body.assignedTo !== undefined) task.assignedTo = req.body.assignedTo;
        if (req.body.dueDate !== undefined) task.dueDate = req.body.dueDate;
        if (req.body.priority) task.priority = req.body.priority;
        if (req.body.description) task.description = req.body.description;

        await meeting.save();

        // ── Notify Creator on Task Completion ────────────────────────
        if (status === 'done' && meeting.createdBy.toString() !== req.user._id.toString()) {
            sendNotification({
                recipient: meeting.createdBy,
                sender: req.user._id,
                type: 'TASK_COMPLETED',
                title: 'Task Completed',
                message: `${req.user.name} completed a task: ${task.description}`,
                link: `/app/meetings/${meeting._id}`
            });
        }

        const populated = await Meeting.findById(meeting._id)
            .populate('team', 'name logo')
            .populate('createdBy', 'name email profilePic')
            .populate('tasks.assignedTo', 'name email profilePic');

        if (io) {
            io.to(`meeting_${meeting._id}`).emit('meeting_update', populated);
            io.to(`team_${meeting.team._id || meeting.team}`).emit('meeting_list_update');
        }

        await bustMeetingCaches(populated);

        res.json(populated);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ── @desc    Get all tasks assigned to current user ────────────────────
// ── @route   GET /api/meetings/my-tasks ────────────────────────────────
// ── @access  Private ───────────────────────────────────────────────────
export const getMyTasks = async (req, res) => {
    try {
        const myTasks = await cacheGetOrSet(
            keys.tasksByUser(req.user._id),
            TTL.TASKS,
            async () => {
                const teams = await Team.find({
                    'members.user': req.user._id
                }).select('_id');

                const teamIds = teams.map(t => t._id);

                const meetings = await Meeting.find({
                    team: { $in: teamIds },
                    'tasks.assignedTo': req.user._id
                })
                    .populate('team', 'name logo')
                    .populate('createdBy', 'name email profilePic')
                    .populate('tasks.assignedTo', 'name email profilePic')
                    .sort({ date: -1 });

                const tasks = [];
                meetings.forEach(meeting => {
                    meeting.tasks.forEach(task => {
                        if (task.assignedTo && task.assignedTo._id.toString() === req.user._id.toString()) {
                            tasks.push({
                                _id: task._id,
                                description: task.description,
                                assignedTo: task.assignedTo,
                                dueDate: task.dueDate,
                                priority: task.priority,
                                status: task.status,
                                meeting: {
                                    _id: meeting._id,
                                    title: meeting.title,
                                    date: meeting.date,
                                    team: meeting.team
                                }
                            });
                        }
                    });
                });

                return toPlain(tasks);
            }
        );

        res.json(myTasks);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// ── @desc    Send a reminder for a task ──────────────────────────────
// ── @route   POST /api/meetings/:id/tasks/:taskId/remind ─────────────
// ── @access  Team Lead / Creator only ────────────────────────────────
export const sendTaskReminder = async (req, res) => {
    try {
        const meeting = await Meeting.findById(req.params.id);
        if (!meeting) {
            return res.status(404).json({ message: 'Meeting not found' });
        }

        const task = meeting.tasks.id(req.params.taskId);
        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }

        if (meeting.createdBy.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Only the meeting creator can send reminders' });
        }

        if (!task.assignedTo) {
            return res.status(400).json({ message: 'Task is unassigned' });
        }

        if (task.status === 'done') {
            return res.status(400).json({ message: 'Task is already completed' });
        }

        await sendNotification({
            recipient: task.assignedTo,
            sender: req.user._id,
            type: 'TASK_REMINDER',
            title: 'Task Reminder',
            message: `Reminder: You have an open task from "${meeting.title}": ${task.description}`,
            link: `/app/meetings/${meeting._id}`
        });

        res.json({ message: 'Reminder sent successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
