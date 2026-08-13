// drawio-desktop mcp-menu-inject: adds an MCP menu to the built-in HTML menu
// bar (between "Extras" and "Help"). This file is appended verbatim to
// drawio/src/main/webapp/js/diagramly/ElectronApp.js at build time (see the
// portable build workflow), so it runs after app.min.js has defined Menus and
// before App.main() creates the editor UI.
//
// The menu talks to the main process over the existing electron.request IPC:
//   getMcpStatus    -> {enabled, port, running}
//   setMcpEnabled   -> {enabled}
//   setMcpPort      -> {port}
(function()
{
	// Marker used by the build script to keep the injection idempotent.
	if (window.drawioMcpMenuInjected)
	{
		return;
	}

	window.drawioMcpMenuInjected = true;

	var mcpStatus = {enabled: false, port: 8890, running: false};

	function requestMcp(msg, success, error)
	{
		if (typeof electron === 'undefined' || electron.request == null)
		{
			if (error != null) error('electron.request unavailable');
			return;
		}

		electron.request(msg, function(data)
		{
			if (data != null && typeof data === 'object')
			{
				mcpStatus = data;
			}

			if (success != null) success(data);
		}, function(errMsg, e)
		{
			if (error != null) error(e || errMsg);
		});
	}

	// Pull the current state once at startup so the first menu open is accurate.
	requestMcp({action: 'getMcpStatus'});

	// Menu labels. mxResources.get returns the input string verbatim when no
	// translation exists, so plain-English labels work without a resource file.
	var labels = {
		enable: 'Enable MCP Server',
		disable: 'Disable MCP Server',
		port: 'Configure MCP Port...',
		status: 'Status',
		on: 'Running',
		off: 'Stopped'
	};

	var menusInit = Menus.prototype.init;

	Menus.prototype.init = function()
	{
		menusInit.apply(this, arguments);
		var editorUi = this.editorUi;

		// Insert 'mcp' between 'extras' and 'help' in the menu bar.
		var items = this.defaultMenuItems;
		var helpIdx = items.indexOf('help');

		if (helpIdx < 0)
		{
			helpIdx = items.length;
		}

		if (items.indexOf('mcp') < 0)
		{
			items.splice(helpIdx, 0, 'mcp');
		}

		// Menu bar title: mxResources.get('mcp') falls back to 'mcp'.
		mxResources.parse('mcp=MCP');

		var self = this;

		this.put('mcp', new Menu(mxUtils.bind(this, function(menu, parent)
		{
			// Refresh state every time the menu opens.
			requestMcp({action: 'getMcpStatus'});

			// Enable / disable toggle.
			var toggleItem = menu.addItem(mcpStatus.running ?
				labels.disable : labels.enable, null, mxUtils.bind(this, function()
			{
				requestMcp({action: 'setMcpEnabled', enabled: !mcpStatus.running});
			}), parent, null, true);

			if (mcpStatus.running)
			{
				menu.addCheckmark(toggleItem, Editor.checkmarkImage);
			}

			// Configure the HTTP port.
			menu.addItem(labels.port, null, mxUtils.bind(this, function()
			{
				editorUi.prompt(labels.port, String(mcpStatus.port), function(newValue)
				{
					var port = parseInt(newValue, 10);

					if (!isNaN(port) && port > 0 && port <= 65535)
					{
						requestMcp({action: 'setMcpPort', port: port});
					}
				}, true);
			}), parent);

			// Read-only status line.
			menu.addSeparator(parent);
			menu.addItem(labels.status + ': ' + (mcpStatus.running ?
				labels.on : labels.off) + ' (http://127.0.0.1:' + mcpStatus.port + '/mcp)',
				null, null, parent, null, false);
		})));
	};
})();
