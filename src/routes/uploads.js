import { Router } from "express";
import { signUpload } from "../direct-uploads.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// Body: { purpose: "report-image" | "completion-image" | "procurement-document" }.
// The client POSTs each file to `uploadUrl` as multipart with `fields` + `file`, then submits the public IDs.
router.post("/sign", (req, res, next) => {
  try {
    res.json(signUpload(req.user, String(req.body?.purpose || "")));
  } catch (error) {
    next(error);
  }
});

export default router;
