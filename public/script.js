'use strict';

document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('plugin-form');
    var generateButton = document.getElementById('generate-button');
    var errorsBox = document.getElementById('form-errors');
    var apiResponseDiv = document.getElementById('api-response');
    var apiResponseContent = document.getElementById('api-response-content');
    var pluginPreviewDiv = document.getElementById('plugin-preview');
    var pluginPreviewContent = document.getElementById('plugin-preview-content');
    var savedConfigsDiv = document.getElementById('saved-configs');
    var savedConfigsList = document.getElementById('saved-configs-list');
    var headerInputs = document.getElementById('header-inputs');
    var apiKeyInput = document.getElementById('apiKey');
    var STORAGE_KEY = 'savedConfigs';

    var savedConfigs = readSavedConfigs();
    updateSavedConfigsList();

    // ---------------------------------------------------------------- events

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        clearErrors();
        generateButton.disabled = true;
        generateButton.textContent = 'Generating...';
        try {
            var config = await collectConfig();
            var response = await postJson('/api/generate-plugin', config);
            if (!response.ok) {
                showErrors(await readError(response));
                return;
            }
            var blob = await response.blob();
            downloadBlob(blob, fileNameFrom(response, 'plugin.zip'));
            showToast('Plugin generated and downloaded successfully!');
            saveConfig(config);
        } catch (error) {
            console.error('Error generating plugin:', error);
            showErrors(['Failed to generate the plugin. Please try again.']);
        } finally {
            generateButton.disabled = false;
            generateButton.textContent = 'Generate Plugin';
        }
    });

    document.getElementById('add-header-button').addEventListener('click', function () { addCustomHeader('', ''); });
    document.getElementById('test-api-button').addEventListener('click', testApi);
    document.getElementById('generate-preview-button').addEventListener('click', generatePreview);
    document.getElementById('save-config-button').addEventListener('click', async function () {
        clearErrors();
        saveConfig(await collectConfig());
        showToast('Configuration saved (without the API key).');
    });
    document.getElementById('generate-api-key').addEventListener('click', function () {
        apiKeyInput.value = generateRandomApiKey();
    });

    // ---------------------------------------------------------------- actions

    async function testApi() {
        clearErrors();
        var config = await collectConfig();
        try {
            var response = await postJson('/api/test-api', {
                apiUrl: config.apiUrl, apiMethod: config.apiMethod, apiKey: config.apiKey, headers: config.headers,
            });
            var data = await response.json();
            if (!response.ok) {
                showErrors([data.error].concat(data.details || []));
                return;
            }
            apiResponseContent.textContent = 'HTTP ' + data.status + '\n\n' +
                (typeof data.body === 'string' ? data.body : JSON.stringify(data.body, null, 2));
            apiResponseDiv.classList.remove('hidden');
        } catch (error) {
            console.error('Error testing API:', error);
            showErrors(['Error testing the API. Please check your configuration.']);
        }
    }

    // The preview is produced by the server, so it is exactly what the download contains.
    async function generatePreview() {
        clearErrors();
        try {
            var response = await postJson('/api/preview-plugin', await collectConfig());
            var data = await response.json();
            if (!response.ok) {
                showErrors([data.error].concat(data.details || []));
                return;
            }
            pluginPreviewContent.replaceChildren();
            data.files.forEach(function (file) {
                var title = document.createElement('h3');
                title.textContent = file.path;
                var pre = document.createElement('pre');
                pre.textContent = file.content;
                pluginPreviewContent.append(title, pre);
            });
            pluginPreviewDiv.classList.remove('hidden');
        } catch (error) {
            console.error('Error generating the preview:', error);
            showErrors(['Failed to generate the preview.']);
        }
    }

    // ---------------------------------------------------------------- form data

    async function collectConfig() {
        var checked = document.querySelector('input[name="apiMethod"]:checked');
        var config = {
            platform: document.getElementById('platform').value,
            pluginName: document.getElementById('pluginName').value,
            description: document.getElementById('description').value.replace(/\s+/g, ' ').trim(),
            apiUrl: document.getElementById('apiUrl').value,
            apiMethod: checked ? checked.value : 'GET',
            apiKey: apiKeyInput.value,
            headers: getCustomHeaders(),
            visualizeData: document.getElementById('visualizeData').checked,
        };
        var logo = document.getElementById('logo').files[0];
        if (logo) config.logoPng = await fileToBase64(logo);
        return config;
    }

    function getCustomHeaders() {
        var headers = {};
        headerInputs.querySelectorAll('.header-input').forEach(function (row) {
            var name = row.querySelector('input[name="headerName[]"]').value.trim();
            var value = row.querySelector('input[name="headerValue[]"]').value;
            if (name && value) headers[name] = value;
        });
        return headers;
    }

    // Built with the DOM API, never with innerHTML: header names and values are user text.
    function addCustomHeader(name, value) {
        var row = document.createElement('div');
        row.className = 'header-input';
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Header Name';
        nameInput.name = 'headerName[]';
        nameInput.setAttribute('aria-label', 'Header name');
        nameInput.value = name;
        var valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.placeholder = 'Header Value';
        valueInput.name = 'headerValue[]';
        valueInput.setAttribute('aria-label', 'Header value');
        valueInput.value = value;
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-header';
        remove.textContent = 'Remove';
        remove.addEventListener('click', function () { row.remove(); });
        row.append(nameInput, valueInput, remove);
        headerInputs.appendChild(row);
    }

    function fileToBase64(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
            reader.onerror = function () { reject(reader.error); };
            reader.readAsDataURL(file);
        });
    }

    // ---------------------------------------------------------------- saved configurations (never the API key)

    function readSavedConfigs() {
        try {
            var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function saveConfig(config) {
        var copy = Object.assign({}, config);
        delete copy.apiKey;
        delete copy.logoPng;
        savedConfigs.push(copy);
        savedConfigs = savedConfigs.slice(-20);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedConfigs)); } catch (e) { /* storage unavailable */ }
        updateSavedConfigsList();
    }

    function updateSavedConfigsList() {
        savedConfigsList.replaceChildren();
        savedConfigs.forEach(function (config, index) {
            var li = document.createElement('li');
            li.textContent = config.pluginName + ' (' + config.platform + ')';
            li.tabIndex = 0;
            li.addEventListener('click', function () { loadSavedConfig(index); });
            li.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadSavedConfig(index); });
            savedConfigsList.appendChild(li);
        });
        savedConfigsDiv.classList.toggle('hidden', savedConfigs.length === 0);
    }

    function loadSavedConfig(index) {
        var config = savedConfigs[index];
        if (!config) return;
        document.getElementById('platform').value = config.platform || 'wordpress';
        document.getElementById('pluginName').value = config.pluginName || '';
        document.getElementById('description').value = config.description || '';
        document.getElementById('apiUrl').value = config.apiUrl || '';
        var method = document.querySelector('input[name="apiMethod"][value="' + (config.apiMethod === 'POST' ? 'POST' : 'GET') + '"]');
        if (method) method.checked = true;
        apiKeyInput.value = '';
        document.getElementById('visualizeData').checked = Boolean(config.visualizeData);
        headerInputs.replaceChildren();
        Object.entries(config.headers || {}).forEach(function (entry) { addCustomHeader(entry[0], String(entry[1])); });
    }

    // ---------------------------------------------------------------- helpers

    function postJson(url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }

    async function readError(response) {
        try {
            var data = await response.json();
            return [data.error].concat(data.details || []);
        } catch (e) {
            return ['The server answered with an error (HTTP ' + response.status + ').'];
        }
    }

    function fileNameFrom(response, fallback) {
        var header = response.headers.get('Content-Disposition') || '';
        var match = header.match(/filename="([A-Za-z0-9._-]+)"/);
        return match ? match[1] : fallback;
    }

    function downloadBlob(blob, name) {
        var url = window.URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.style.display = 'none';
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { window.URL.revokeObjectURL(url); }, 4000);
    }

    function showErrors(messages) {
        errorsBox.replaceChildren();
        messages.filter(Boolean).forEach(function (message) {
            var p = document.createElement('p');
            p.textContent = message;
            errorsBox.appendChild(p);
        });
        errorsBox.classList.remove('hidden');
    }

    function clearErrors() {
        errorsBox.replaceChildren();
        errorsBox.classList.add('hidden');
    }

    function showToast(message) {
        var toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(function () { toast.classList.remove('show'); }, 3000);
    }

    // Uses the browser's cryptographic random generator (Math.random is predictable).
    function generateRandomApiKey() {
        var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        var bytes = new Uint32Array(32);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, function (n) { return characters[n % characters.length]; }).join('');
    }
});
