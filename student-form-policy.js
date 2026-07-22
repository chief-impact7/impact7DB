export const requiresAcquisitionSource = (isEditMode, existingStudent) =>
    !isEditMode && !existingStudent;

export function setAcquisitionSourceRequired(form, required) {
    const field = form.acquisition_source;
    field.required = required;
    field.labels[0].textContent = `유입 채널${required ? ' *' : ''}`;
}
