import { getRedis, isRedisReady } from '../config/redis.js';

const PREFIX = process.env.REDIS_PREFIX || 'meetloop';

export const TTL = {
    USER: 10 * 60,
    TEAM: 2 * 60,
    TEAMS_LIST: 2 * 60,
    MEETING: 60,
    MEETINGS_LIST: 60,
    TASKS: 45,
    NOTIFICATIONS: 20,
    INVITE: 5 * 60,
    RATE_LIMIT: 15 * 60
};

export const keys = {
    user: (id) => `${PREFIX}:user:${id}`,
    teamsByUser: (userId) => `${PREFIX}:teams:user:${userId}`,
    team: (id) => `${PREFIX}:team:${id}`,
    meetingsByUser: (userId) => `${PREFIX}:meetings:user:${userId}`,
    meeting: (id) => `${PREFIX}:meeting:${id}`,
    tasksByUser: (userId) => `${PREFIX}:tasks:user:${userId}`,
    notifications: (userId) => `${PREFIX}:notifications:${userId}`,
    invite: (code) => `${PREFIX}:invite:${String(code).toUpperCase()}`,
    rateLimit: (bucket, id) => `${PREFIX}:rl:${bucket}:${id}`
};

export const toPlain = (doc) => {
    if (doc == null) return doc;
    return JSON.parse(JSON.stringify(doc));
};

export const cacheGet = async (key) => {
    if (!isRedisReady()) return null;
    try {
        const raw = await getRedis().get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        console.error('[Cache] get failed:', err.message);
        return null;
    }
};

export const cacheSet = async (key, value, ttlSeconds) => {
    if (!isRedisReady() || value === undefined) return false;
    try {
        const payload = JSON.stringify(value);
        if (ttlSeconds) {
            await getRedis().set(key, payload, { EX: ttlSeconds });
        } else {
            await getRedis().set(key, payload);
        }
        return true;
    } catch (err) {
        console.error('[Cache] set failed:', err.message);
        return false;
    }
};

export const cacheDel = async (...keyList) => {
    if (!isRedisReady()) return 0;
    const flattened = keyList.flat().filter(Boolean);
    if (!flattened.length) return 0;
    try {
        return await getRedis().del(flattened);
    } catch (err) {
        console.error('[Cache] del failed:', err.message);
        return 0;
    }
};

export const cacheGetOrSet = async (key, ttlSeconds, loader) => {
    const cached = await cacheGet(key);
    if (cached !== null) return cached;

    const fresh = await loader();
    if (fresh !== undefined && fresh !== null) {
        await cacheSet(key, toPlain(fresh), ttlSeconds);
    }
    return fresh;
};

export const incrWithExpire = async (key, windowSec) => {
    if (!isRedisReady()) return null;
    try {
        const client = getRedis();
        const count = await client.incr(key);
        if (count === 1) {
            await client.expire(key, windowSec);
        }
        return count;
    } catch (err) {
        console.error('[Cache] incr failed:', err.message);
        return null;
    }
};

const memberId = (m) => {
    if (!m) return null;
    const raw = m.user?._id || m.user || m;
    return raw ? String(raw) : null;
};

const userIdOf = (value) => {
    if (!value) return null;
    const raw = value._id || value;
    return raw ? String(raw) : null;
};

export const invalidateUser = async (userId) => {
    if (!userId) return;
    const id = String(userId);
    await cacheDel(
        keys.user(id),
        keys.teamsByUser(id),
        keys.meetingsByUser(id),
        keys.tasksByUser(id),
        keys.notifications(id)
    );
};

export const invalidateTeam = async (team, extraUserIds = []) => {
    if (!team) return;
    const teamId = String(team._id || team);
    const memberIds = (team.members || []).map(memberId).filter(Boolean);
    const ids = [...new Set([...memberIds, ...extraUserIds.map(String)])];

    await cacheDel(
        keys.team(teamId),
        team.inviteCode ? keys.invite(team.inviteCode) : null,
        ...ids.flatMap((id) => [
            keys.teamsByUser(id),
            keys.meetingsByUser(id),
            keys.tasksByUser(id)
        ])
    );
};

export const invalidateMeeting = async (meeting, extraUserIds = []) => {
    if (!meeting) return;
    const meetingId = String(meeting._id || meeting);
    const team = meeting.team;
    const teamId = team?._id || team;
    const assigneeIds = (meeting.tasks || [])
        .map((t) => userIdOf(t.assignedTo))
        .filter(Boolean);
    const creatorId = userIdOf(meeting.createdBy);
    const ids = [...new Set([...assigneeIds, creatorId, ...extraUserIds.map(String)].filter(Boolean))];

    await cacheDel(
        keys.meeting(meetingId),
        teamId ? keys.team(String(teamId)) : null,
        ...ids.flatMap((id) => [
            keys.meetingsByUser(id),
            keys.tasksByUser(id),
            keys.notifications(id)
        ])
    );
};

export const invalidateNotifications = async (userId) => {
    if (!userId) return;
    await cacheDel(keys.notifications(String(userId)));
};
