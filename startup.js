export async function runAuthenticatedStartup({
    loadUserRole,
    loadPopulationPerms,
    loadSemesterSettings,
    getCurrentSemester,
    loadStudentList,
    generateDailyStatsIfNeeded,
    onError,
}) {
    try {
        await Promise.all([
            loadUserRole(),
            loadPopulationPerms(),
            loadSemesterSettings(),
        ]);
        getCurrentSemester();
        await loadStudentList();
        await generateDailyStatsIfNeeded();
        return true;
    } catch (error) {
        onError(error);
        return false;
    }
}
