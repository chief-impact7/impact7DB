# 🏫 Academy Integrated Management Hybrid System (Master Overview v2.0)

## 1. Overview & Goal
This project aims to build a **centralized integrated database** using the Google ecosystem (Google Workspace, Firebase) and modern AI coding IDEs (Antigravity, Claude Code, Gemini CLI). 
Various independent web apps (Attendance, Report Card, Daily Flow Check, etc.) will be developed to interoperate based on this central DB. All UIs must strictly follow the **minimalist Google Material Design 3** guidelines, resembling native Google apps.

## 2. Core Principles
- **Real-name & Time Tracking:** Every database modification MUST record the operator's `google_login_id` and `timestamp`.
- **Hybrid Data Management:** Bulk data (promotions, initial DB setup) is handled via Google Sheets + GAS. Daily operational data is handled via the custom web dashboard.
- **Microservices Architecture (API-based):** Instead of building one heavy application, develop multiple lightweight web apps that fetch/update the central DB (Firestore) APIs to maximize scalability.

## 3. Central Database Architecture (Firebase Firestore)
A NoSQL-based central DB shared across all apps.

| Collection | Main Fields | Purpose & Connected Apps |
| :--- | :--- | :--- |
| **`students`** | `student_id`, `name`, `branch`, `level`, `status` | Master student info (Shared across all apps) |
| **`history_logs`** | `student_id`, `change_type`, `before`, `after`, **`google_login_id`**, **`timestamp`** | All modification history (Userlog App) |
| **`test_meta`** | `test_id`, `test_type`, `total_score` | Test dictionary (Test Management App) |
| **`test_records`** | `student_id`, `test_id`, `score`, `google_login_id`, `timestamp` | Individual test results (Report Card App) |
| **`daily_flow`** | `student_id`, `date`, `check_in`, `task_1_done`, `check_out` | Daily student flow check (Flow Check App) |

## 4. 🚀 AI Productivity Settings (MCP, Plugin, Agent)
- **Google Drive / Sheets MCP:** Connect Claude/Gemini to directly read/analyze the academy's Google Sheets.
- **Firebase (Firestore) MCP:** AI must query the actual DB schema, not mock data.
- **Material UI Agent (Antigravity):** *System Prompt:* "You are a Frontend Expert strictly adhering to Google Material Design 3. Use Material Web Components (MWC) instead of complex custom CSS. Create minimalist, intuitive UIs with ample whitespace and rounded corners like Google Calendar or Gmail."
- **Common Utility (`userlog.js`):** A middleware required for ANY DB write operation to automatically inject the user's Google ID and timestamp.

## 5. Workspace Structure (`academy-central-workspace/`)
- **`Rules_EN.md`**: Core rules, glossary, DB schema. (MUST READ for all AIs)
- **`gemini.md` / `claude.md`**: Agent roles and personality docs.
- **`gemininotes.md` / `claudnotes.md`**: Handoff notes for the next AI after task completion.
- **`.gitignore` / `.claudesignore` / `.geminiignore`**: Ignore files to prevent `.env` leaks and token waste.
- **`userlog.js` & `auth.js`**: Core modules for tracking and Google Auth.

## 6. Agent Roles
- **🎨 Google Antigravity (UI/Frontend):** Create minimalist Material Design web app screens.
- **🧠 Claude Code (Backend/Integration):** Advanced `userlog.js` logic, complex JOIN operations (e.g., Report Cards), cross-app API design.
- **⚡ Gemini CLI (Automation/Google Ecosystem):** Bulk Google Sheets integration via Google Apps Script (GAS), OAuth workflows.

## 7. Security & Version Control
- **GitHub Repository:** Keep code in a Private repo to allow instant rollback from AI mistakes.
- **Security Policy:** NEVER hardcode Firebase Service Account Keys (`credentials.json`) or API keys. Always use `.env` files and strictly block them from GitHub uploads.