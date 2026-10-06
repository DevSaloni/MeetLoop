import Team from '../models/Team.js';
import sendEmail from '../utils/sendEmail.js';
import { sendNotification } from '../utils/notificationHelper.js';
import { io } from '../index.js';
import {
    cacheGet,
    cacheGetOrSet,
    cacheSet,
    invalidateTeam,
    invalidateUser,
    keys,
    TTL,
    toPlain
} from '../utils/cache.js';

// @desc    Create a new team
// @route   POST /api/teams
// @access  Private (Team Lead only)
export const createTeam = async (req, res) => {
    try {
        const { name, description, logo } = req.body;

        // Only Team Leads can create teams
        if (req.user.role !== 'Team Lead') {
            return res.status(403).json({
                message: 'Only Team Leads can create teams'
            });
        }

        // Remove restriction: Allow Team Leads to create multiple teams
        /*
        const existingTeam = await Team.findOne({ creator: req.user._id });
        if (existingTeam) {
            return res.status(400).json({
                message: 'You already have a team. Upgrade to create multiple teams.'
            });
        }
        */

        const team = await Team.create({
            name,
            description,
            logo,
            creator: req.user._id,
            members: [{
                user: req.user._id,
                role: 'Team Lead'
            }]
        });

        // Populate creator and member details
        const populatedTeam = await Team.findById(team._id)
            .populate('creator', 'name email profilePic')
            .populate('members.user', 'name email profilePic role jobRole');

        await invalidateTeam(populatedTeam);
        await invalidateUser(req.user._id);

        res.status(201).json({
            success: true,
            data: populatedTeam
        });
    } catch (error) {
        console.error(error);
        if (error.code === 11000) {
            return res.status(400).json({ message: 'A team with this name already exists' });
        }
        res.status(500).json({ message: error.message });
    }
};

// @desc    Join a team via invite code
// @route   POST /api/teams/join
// @access  Private
export const joinTeam = async (req, res) => {
    try {
        const { inviteCode } = req.body;

        if (!inviteCode) {
            return res.status(400).json({ message: 'Please provide an invite code' });
        }

        const normalizedCode = inviteCode.toUpperCase();
        const cachedInvite = await cacheGet(keys.invite(normalizedCode));
        let team = cachedInvite?._id ? await Team.findById(cachedInvite._id) : null;

        if (!team) {
            team = await Team.findOne({ inviteCode: normalizedCode });
            if (team) {
                await cacheSet(keys.invite(normalizedCode), { _id: team._id }, TTL.INVITE);
            }
        }

        if (!team) {
            return res.status(404).json({ message: 'Invalid invite code. No team found.' });
        }

        // Check if user is already a member
        const isAlreadyMember = team.members.some(
            m => m.user.toString() === req.user._id.toString()
        );

        if (isAlreadyMember) {
            return res.status(400).json({ message: 'You are already a member of this team' });
        }

        // Check team capacity
        if (team.members.length >= team.maxMembers) {
            return res.status(400).json({
                message: `This team has reached its maximum capacity of ${team.maxMembers} members`
            });
        }

        // Add user to team
        team.members.push({
            user: req.user._id,
            role: req.user.role || 'Contributor'
        });

        await team.save();

        // Notify Team Lead that someone joined
        sendNotification({
            recipient: team.creator,
            sender: req.user._id,
            type: 'TEAM_INVITE',
            title: 'New Team Member',
            message: `${req.user.name} joined your team "${team.name}"`,
            link: `/app/teams`
        });

        if (io) {
            io.to(`team_${team._id}`).emit('team_update', {
                teamId: team._id,
                action: 'member_joined'
            });
        }

        const populatedTeam = await Team.findById(team._id)
            .populate('creator', 'name email profilePic')
            .populate('members.user', 'name email profilePic role jobRole');

        await invalidateTeam(populatedTeam, [req.user._id]);
        await invalidateUser(req.user._id);

        res.status(200).json({
            success: true,
            message: `Successfully joined "${team.name}"`,
            data: populatedTeam
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get all teams the current user belongs to
// @route   GET /api/teams
// @access  Private
export const getMyTeams = async (req, res) => {
    try {
        const payload = await cacheGetOrSet(
            keys.teamsByUser(req.user._id),
            TTL.TEAMS_LIST,
            async () => {
                const teams = await Team.find({
                    'members.user': req.user._id
                })
                    .populate('creator', 'name email profilePic')
                    .populate('members.user', 'name email profilePic role jobRole')
                    .sort({ createdAt: -1 });

                const data = toPlain(teams);
                return { success: true, count: data.length, data };
            }
        );

        res.status(200).json(payload);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get a single team by ID
// @route   GET /api/teams/:id
// @access  Private (must be a member)
export const getTeamById = async (req, res) => {
    try {
        const team = await cacheGetOrSet(
            keys.team(req.params.id),
            TTL.TEAM,
            async () => {
                const doc = await Team.findById(req.params.id)
                    .populate('creator', 'name email profilePic')
                    .populate('members.user', 'name email profilePic role jobRole');
                return doc ? toPlain(doc) : null;
            }
        );

        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        const isMember = team.members.some(
            m => (m.user?._id || m.user)?.toString() === req.user._id.toString()
        );

        if (!isMember) {
            return res.status(403).json({ message: 'You are not a member of this team' });
        }

        res.status(200).json({
            success: true,
            data: team
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update team details
// @route   PUT /api/teams/:id
// @access  Private (Team Lead / Creator only)
export const updateTeam = async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);

        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        // Only the creator can update
        if (team.creator.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Only the team creator can update team details' });
        }

        const { name, description, logo } = req.body;
        if (name) team.name = name;
        if (description !== undefined) team.description = description;
        if (logo !== undefined) team.logo = logo;

        await team.save();

        const updatedTeam = await Team.findById(team._id)
            .populate('creator', 'name email profilePic')
            .populate('members.user', 'name email profilePic role jobRole');

        await invalidateTeam(updatedTeam);

        res.status(200).json({
            success: true,
            data: updatedTeam
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Remove a member from a team
// @route   DELETE /api/teams/:id/members/:userId
// @access  Private (Team Lead only)
export const removeMember = async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);

        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        // Only the creator can remove members
        if (team.creator.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Only the team creator can remove members' });
        }

        // Cannot remove the creator
        if (req.params.userId === team.creator.toString()) {
            return res.status(400).json({ message: 'Cannot remove the team creator' });
        }

        team.members = team.members.filter(
            m => m.user.toString() !== req.params.userId
        );

        await team.save();

        if (io) {
            io.to(`team_${team._id}`).emit('team_update', {
                teamId: team._id,
                action: 'member_removed',
                userId: req.params.userId
            });
        }

        const updatedTeam = await Team.findById(team._id)
            .populate('creator', 'name email profilePic')
            .populate('members.user', 'name email profilePic role jobRole');

        await invalidateTeam(updatedTeam, [req.params.userId]);
        await invalidateUser(req.params.userId);

        res.status(200).json({
            success: true,
            message: 'Member removed successfully',
            data: updatedTeam
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Leave a team
// @route   DELETE /api/teams/:id/leave
// @access  Private
export const leaveTeam = async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);

        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        // Creator cannot leave their own team (must delete it)
        if (team.creator.toString() === req.user._id.toString()) {
            return res.status(400).json({
                message: 'Team creator cannot leave. Transfer ownership or delete the team.'
            });
        }

        team.members = team.members.filter(
            m => m.user.toString() !== req.user._id.toString()
        );

        await team.save();

        await invalidateTeam(team, [req.user._id]);
        await invalidateUser(req.user._id);

        if (io) {
            io.to(`team_${team._id}`).emit('team_update', {
                teamId: team._id,
                action: 'member_left',
                userId: req.user._id
            });
        }

        res.status(200).json({
            success: true,
            message: 'You have left the team'
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Regenerate invite code
// @route   PUT /api/teams/:id/regenerate-code
// @access  Private (Team Lead only)
export const regenerateInviteCode = async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);

        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        if (team.creator.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Only the team creator can regenerate the invite code' });
        }

        const crypto = await import('crypto');
        const previousCode = team.inviteCode;
        team.inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();
        await team.save();

        await invalidateTeam({ ...team.toObject(), inviteCode: previousCode });
        await invalidateTeam(team);

        res.status(200).json({
            success: true,
            inviteCode: team.inviteCode
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Delete a team
// @route   DELETE /api/teams/:id
// @access  Private (Creator only)
export const deleteTeam = async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);

        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        if (team.creator.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Only the team creator can delete this team' });
        }

        await Team.findByIdAndDelete(req.params.id);
        await invalidateTeam(team);

        res.status(200).json({
            success: true,
            message: 'Team deleted successfully'
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
};

// @desc    Send invite email to a user
// @route   POST /api/teams/:id/invite
// @access  Private (Team Lead only)
export const sendInviteEmail = async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);

        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        // Only the creator can send invites
        if (team.creator.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Only the team creator can send invites' });
        }

        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Please provide an email address' });
        }

        const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        const inviteLink = `${clientUrl}/signup?invite=${team.inviteCode}`;

        const message = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <h2 style="color: #f97316;">You're Invited to Join MeetLoop!</h2>
                <p>Hello,</p>
                <p><strong>${req.user.name}</strong> has invited you to join their accountability workspace: <strong>${team.name}</strong>.</p>
                <p>MeetLoop helps teams extract tasks and track accountability automatically from meeting notes.</p>
                <div style="margin: 30px 0; padding: 20px; background-color: #f9f9f9; border-radius: 8px; text-align: center;">
                    <p style="margin: 0; font-size: 14px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Your Team Invite Code</p>
                    <h1 style="margin: 10px 0 0 0; font-family: monospace; font-size: 36px; letter-spacing: 5px; color: #333;">${team.inviteCode}</h1>
                </div>
                <a href="${inviteLink}" style="display: block; width: 100%; text-align: center; background-color: #f97316; color: white; padding: 15px 0; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">Accept Invitation</a>
                <p style="margin-top: 30px; font-size: 12px; color: #999; text-align: center;">If you didn't expect this invitation, you can safely ignore this email.</p>
            </div>
        `;

        await sendEmail({
            email: email,
            subject: `Invitation to join ${team.name} on MeetLoop`,
            message
        });

        res.status(200).json({
            success: true,
            message: `Invitation email sent to ${email}`
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Email could not be sent. Please check configuration.' });
    }
};
