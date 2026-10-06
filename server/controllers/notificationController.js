import Notification from '../models/Notification.js';
import { cacheGetOrSet, invalidateNotifications, keys, TTL, toPlain } from '../utils/cache.js';

// Get user's notifications
export const getNotifications = async (req, res) => {
    try {
        const notifications = await cacheGetOrSet(
            keys.notifications(req.user._id),
            TTL.NOTIFICATIONS,
            async () => {
                const docs = await Notification.find({ recipient: req.user._id })
                    .sort({ createdAt: -1 })
                    .limit(20);
                return toPlain(docs);
            }
        );
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Mark notification as read
export const markAsRead = async (req, res) => {
    try {
        const notification = await Notification.findByIdAndUpdate(
            req.params.id,
            { read: true },
            { new: true }
        );
        await invalidateNotifications(req.user._id);
        res.json(notification);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Mark all as read
export const markAllAsRead = async (req, res) => {
    try {
        await Notification.updateMany(
            { recipient: req.user._id, read: false },
            { read: true }
        );
        await invalidateNotifications(req.user._id);
        res.json({ message: 'All notifications marked as read' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Delete notification
export const deleteNotification = async (req, res) => {
    try {
        await Notification.findByIdAndDelete(req.params.id);
        await invalidateNotifications(req.user._id);
        res.json({ message: 'Notification deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
