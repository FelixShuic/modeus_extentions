function submitGroups(submitButton) {
    console.log(submitButton);
    submitButton.addEventListener('click', submitGroups);
    const form = document.getElementById('modeus-groups');
    const formData = new FormData(form);
    console.log(formData);
}