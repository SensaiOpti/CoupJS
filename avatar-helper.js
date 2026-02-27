// Avatar Helper - Shared utility for rendering avatars across the site

/**
 * Check if an avatar string is an image file or emoji
 * @param {string} avatar - Avatar string (emoji or filename)
 * @returns {boolean} - True if image, false if emoji
 */
function isImageAvatar(avatar) {
  if (!avatar) return false;
  return avatar.includes('.png') || avatar.includes('.jpg') || avatar.includes('.jpeg') || avatar.includes('.gif') || avatar.includes('.webp');
}

/**
 * Render avatar HTML for a given avatar string
 * @param {string} avatar - Avatar string (emoji or filename)
 * @param {string} size - Size class (e.g., 'w-10 h-10', 'w-8 h-8')
 * @param {string} extraClasses - Additional CSS classes
 * @returns {string} - HTML string for avatar
 */
function renderAvatarHTML(avatar, size = 'w-10 h-10', extraClasses = '') {
  const defaultAvatar = '👤';
  const avatarValue = avatar || defaultAvatar;
  
  if (isImageAvatar(avatarValue)) {
    return `<div class="${size} bg-gray-600 rounded-full flex items-center justify-center overflow-hidden flex-shrink-0 ${extraClasses}">
      <img src="/images/avatars/${avatarValue}" alt="Avatar" class="w-full h-full object-cover">
    </div>`;
  } else {
    return `<div class="${size} bg-gray-600 rounded-full flex items-center justify-center text-xl flex-shrink-0 ${extraClasses}">
      ${avatarValue}
    </div>`;
  }
}

/**
 * Update an existing avatar element
 * @param {HTMLElement} element - DOM element to update
 * @param {string} avatar - Avatar string (emoji or filename)
 */
function updateAvatarElement(element, avatar) {
  const defaultAvatar = '👤';
  const avatarValue = avatar || defaultAvatar;
  
  if (isImageAvatar(avatarValue)) {
    element.innerHTML = `<img src="/images/avatars/${avatarValue}" alt="Avatar" class="w-full h-full object-cover rounded-full">`;
  } else {
    element.innerHTML = '';
    element.textContent = avatarValue;
  }
}
