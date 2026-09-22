const express = require('express');
const router = express.Router();
const AssistantController = require('../controllers/assistantController');
const { authenticate } = require('../middleware/authMiddleware');

// Get permissions matrix for a role
router.get('/permissions', authenticate, AssistantController.getPermissions);

// List assistants for current user
router.get('/', authenticate, AssistantController.listAssistants);

// Register a new trusted assistant
router.post('/register', authenticate, AssistantController.registerAssistant);

// Create draft transfer (helper initiated, requires owner confirmation)
router.post('/draft-transfer', authenticate, AssistantController.createDraftTransfer);

// Emergency Assistance trigger ("I Need Assistance")
router.post('/emergency-assistance', authenticate, AssistantController.requestEmergencyAssistance);

module.exports = router;
