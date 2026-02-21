/**
 * Academy Flow Dashboard - Layout & Logic Placeholders
 */

document.addEventListener("DOMContentLoaded", () => {
    // Bind UI elements setup
    setupEventListeners();
});

/**
 * Empty placeholder for Google Login functionality.
 * To be wired up with Firebase / Google Auth later.
 */
function handleLogin() {
    console.log("Login clicked. Future backend integration goes here.");
}

/**
 * Empty placeholder for saving Daily Flow Check data.
 * To be wired up with backend/database later.
 */
function saveDailyFlow() {
    // Collect data (just for demonstration)
    const checkInTime = document.getElementById("checkInTime").value;
    const checkOutTime = document.getElementById("checkOutTime").value;
    const task1 = document.getElementById("task1").checked;

    console.log("Saving changes...", { checkInTime, checkOutTime, vocabTest: task1 });
    // Alert is just for UI validation locally
    alert("Changes saved locally! (Backend not connected)");
}

/**
 * Placeholder for selecting a student card from the sidebar.
 */
function handleStudentSelection(event) {
    const card = event.currentTarget;

    // Remove active class from all cards
    document.querySelectorAll('.student-card').forEach(c => c.classList.remove('active'));

    // Add active class to clicked card
    card.classList.add('active');

    const name = card.querySelector('.name').innerText;
    console.log(`Student ${name} selected.`);

    // Update main panel UI (mock)
    document.querySelector('.student-name').innerText = name;
}

/**
 * Assign events to elements
 */
function setupEventListeners() {
    // Top right login button
    const loginBtn = document.getElementById("loginBtn");
    if (loginBtn) {
        loginBtn.addEventListener("click", handleLogin);
    }

    // Bottom save changes button
    const saveBtn = document.getElementById("saveBtn");
    if (saveBtn) {
        saveBtn.addEventListener("click", saveDailyFlow);
    }

    // Student card clicks
    const studentCards = document.querySelectorAll(".student-card");
    studentCards.forEach(card => {
        card.addEventListener("click", handleStudentSelection);
    });
}
