const { als } = require('../config/tenantContext');
const { getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');

// In-memory registry cache so tenant resolution costs no DB round-trip on the
// hot path. 60s TTL keeps registry edits (status flips, config changes) fresh.
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

const resolveProject = async (projectCode) => {
  const cached = cache.get(projectCode);
  if (cached && cached.expires > Date.now()) {
    return cached.project;
  }

  const Project = getProjectModel();
  const project = await Project.findOne({
    project_code: projectCode,
    status: 'active',
  }).lean();

  cache.set(projectCode, { project, expires: Date.now() + CACHE_TTL_MS });
  return project;
};

// Resolves the tenant for every /api request. Priority:
//   1. X-Project-Code header (canonical — works on GETs)
//   2. project_code in body/query (backward compatible with existing apps)
//   3. DEFAULT_PROJECT_CODE env (transition fallback for clients that don't
//      send a code yet, e.g. the current admin panel)
const tenantResolver = async (req, res, next) => {
  try {
    const raw =
      req.headers['x-project-code'] ||
      (req.body && req.body.project_code) ||
      (req.query && req.query.project_code) ||
      process.env.DEFAULT_PROJECT_CODE;

    if (!raw || String(raw).trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'project_code is required (send X-Project-Code header)',
      });
    }

    const projectCode = String(raw).trim().toUpperCase();
    const project = await resolveProject(projectCode);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: `Unknown or inactive project code: ${projectCode}`,
      });
    }

    const connection = getTenantDb(project.db_name);
    req.tenant = { projectCode, project, db: connection };

    // Backfill the legacy body field. Tenancy is resolved from the header now,
    // but many handlers still read req.body.project_code — to echo it back, and
    // some to validate it. Injecting the resolved code here means a client that
    // sends only the header is never rejected for "project_code is required",
    // and the two can no longer disagree.
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      req.body.project_code = projectCode;
    }

    // Everything downstream of this call (all route handlers and their async
    // work) sees this tenant's connection via the model proxies.
    als.run({ connection, project }, () => next());
  } catch (error) {
    next(error);
  }
};

const clearTenantCache = () => cache.clear();

module.exports = { tenantResolver, clearTenantCache, resolveProject };
