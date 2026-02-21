// auth.js
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from "firebase/auth";

// Note: Ensure Firebase is initialized in your main entry file (e.g., app.js or firebase-config.js)
const auth = getAuth();
const provider = new GoogleAuthProvider();

// IMPORTANT: If you use Google Workspace for the academy, uncomment the line below 
// and replace 'your-academy-domain.com' with your actual domain to restrict access.
// provider.setCustomParameters({ hd: "your-academy-domain.com" });

/**
 * Handle Google Sign-In via Popup
 * @returns {Promise<Object>} The authenticated user object
 */
export const signInWithGoogle = async () => {
    try {
        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        console.log(`[AUTH SUCCESS] Logged in as: ${user.email}`);
        return user;
    } catch (error) {
        console.error("[AUTH ERROR] Google Sign-In failed:", error.code, error.message);
        throw error;
    }
};

/**
 * Handle User Logout
 */
export const logout = async () => {
    try {
        await signOut(auth);
        console.log("[AUTH SUCCESS] User logged out successfully.");
    } catch (error) {
        console.error("[AUTH ERROR] Logout failed:", error);
        throw error;
    }
};