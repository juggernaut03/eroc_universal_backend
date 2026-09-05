/**
 * Granular permission middleware.
 * Must be used AFTER protect + authorize('admin') so req.user is guaranteed.
 */
const checkPermission = (section, action) => {
  return (req, res, next) => {
    // Super admins bypass all permission checks
    if (req.user.isSuperAdmin) return next();

    const sectionPerms = req.user.permissions?.[section];
    if (!sectionPerms || !sectionPerms[action]) {
      return res.status(403).json({
        success: false,
        message: `You do not have permission to ${action} in ${section}`
      });
    }

    next();
  };
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user.isSuperAdmin) {
    return res.status(403).json({
      success: false,
      message: 'Super admin access required'
    });
  }
  next();
};

// Gate for the image-CDN tools (routes/admin/image-cdn.js). Unlike every
// other gate in this file, this one does NOT bypass for isSuperAdmin — the
// whole point of this flag is that most super admins should not see this
// surface. Only an admin with imageCdnAccess explicitly set gets through,
// regardless of role.
const requireImageCdnAccess = (req, res, next) => {
  if (!req.user.imageCdnAccess) {
    return res.status(403).json({
      success: false,
      message: 'You do not have access to the image CDN tools.'
    });
  }
  next();
};

/**
 * Tenant scoping for admins. Super admins may operate on any project;
 * other admins only on projects listed in their allowed_project_codes.
 * Must run AFTER protect + the tenant resolver.
 */
const requireProjectAccess = (req, res, next) => {
  if (req.user.isSuperAdmin) return next();

  const projectCode = req.tenant?.projectCode;
  const allowed = req.user.allowed_project_codes || [];

  if (!projectCode || !allowed.includes(projectCode)) {
    return res.status(403).json({
      success: false,
      message: `You do not have access to project ${projectCode || '(unknown)'}`
    });
  }

  next();
};

module.exports = { checkPermission, requireSuperAdmin, requireProjectAccess, requireImageCdnAccess };
