odoo.define('web.web_widget_text_markdown', function(require) {

    "use strict";

    var core = require('web.core');
    var Model = require('web.Model');
    var Widget = require('web.Widget');
    var common = require('web.form_common');
    var formats = require('web.formats');
    var session = require('web.session');

    var ace_call = require('website.ace_call');


    var QWeb = core.qweb;
    var _lt = core._lt;

    var accented_letters_mapping = {
        'a': '[àáâãäå]',
        'ae': 'æ',
        'c': 'ç',
        'e': '[èéêë]',
        'i': '[ìíîï]',
        'n': 'ñ',
        'o': '[òóôõö]',
        'oe': 'œ',
        'u': '[ùúûűü]',
        'y': '[ýÿ]',
        ' ': '[()\\[\\]]',
    };

    // The MentionManager allows the Composer to register listeners. For each
    // listener, it detects if the user is currently typing a mention (starting by a
    // given delimiter). If so, if fetches mention suggestions and renders them. On
    // suggestion clicked, it updates the selection for the corresponding listener.
    var MentionManager = Widget.extend({
        className: 'dropdown o_composer_mention_dropdown',

        events: {
            "mouseover .o_mention_proposition": "on_hover_mention_proposition",
            "click .o_mention_proposition": "on_click_mention_item",
        },

        init: function(parent, options) {
            this._super.apply(this, arguments);

            this.composer = parent;
            this.options = _.extend({}, options, {
                min_length: 0,
                typing_speed: 200,
            });

            this.open = false;
            this.listeners = [];
            this.set('mention_suggestions', []);
            this.on('change:mention_suggestions', this, this._render_suggestions);
        },

        // Events
        on_hover_mention_proposition: function(event) {
            var $elem = $(event.currentTarget);
            this.$('.o_mention_proposition').removeClass('active');
            $elem.addClass('active');
        },
        on_click_mention_item: function(event) {
            event.preventDefault();

            var text_input = this.composer.$txt.val();
            var id = $(event.currentTarget).data('id');
            var selected_suggestion = _.find(_.flatten(this.get('mention_suggestions')), function(s) {
                return s.id === id;
            });
            var get_mention_index = function(matches, cursor_position) {
                for (var i = 0; i < matches.length; i++) {
                    if (cursor_position <= matches[i].index) {
                        return i;
                    }
                }
                return i;
            };

            // add the selected suggestion to the list
            if (this.active_listener.selection.length) {
                // get mention matches (ordered by index in the text)
                var matches = this._get_match(text_input, this.active_listener);
                var index = get_mention_index(matches, this._get_selection_positions().start);
                this.active_listener.selection.splice(index, 0, selected_suggestion);
            } else {
                this.active_listener.selection.push(selected_suggestion);
            }

            // update input text, and reset dropdown
            var cursor_position = this._get_selection_positions().start;
            var text_left = text_input.substring(0, cursor_position - (this.mention_word.length + 1));
            var text_right = text_input.substring(cursor_position, text_input.length);
            var text_input_new = text_left + this.active_listener.delimiter + selected_suggestion.name + ' ' + text_right;
            this.composer.$txt.val(text_input_new);
            this._set_cursor_position(text_left.length + selected_suggestion.name.length + 2);
            this.set('mention_suggestions', []);
        },

        // Public API
        /**
         * Registers a new listener, described by an object containing the following keys
         * @param {char} [delimiter] the mention delimiter
         * @param {function} [fetch_callback] the callback to fetch mention suggestions
         * @param {string} [model] the model used for redirection
         * @param {string} [redirect_classname] the classname of the <a> wrapping the mention
         */
        register: function(listener) {
            this.listeners.push(_.extend(listener, {
                selection: [],
            }));
        },

        /**
         * Returns true if the mention suggestions dropdown is open, false otherwise
         */
        is_open: function() {
            return this.open;
        },

        get_listener_selection: function(delimiter) {
            var listener = _.findWhere(this.listeners, {
                delimiter: delimiter
            });
            return listener ? listener.selection : [];
        },

        proposition_navigation: function(keycode) {
            var $active = this.$('.o_mention_proposition.active');
            if (keycode === $.ui.keyCode.ENTER) { // selecting proposition
                $active.click();
            } else { // navigation in propositions
                var $to;
                if (keycode === $.ui.keyCode.DOWN) {
                    $to = $active.nextAll('.o_mention_proposition').first();
                } else {
                    $to = $active.prevAll('.o_mention_proposition').first();
                }
                if ($to.length) {
                    $active.removeClass('active');
                    $to.addClass('active');
                }
            }
        },

        /**
         * Detects if the user is currently typing a mention word
         * @return the search string if it is, false otherwise
         */
        detect_delimiter: function() {
            var self = this;
            var text_val = this.composer.$txt.val();
            var cursor_position = this._get_selection_positions().start;
            var left_string = text_val.substring(0, cursor_position);

            function validate_keyword(delimiter) {
                var search_str = text_val.substring(left_string.lastIndexOf(delimiter) - 1, cursor_position);
                var pattern = "(^" + delimiter + "|(^\\s" + delimiter + "))";
                var regex_start = new RegExp(pattern, "g");
                search_str = search_str.replace(/^\s\s*|^[\n\r]/g, '');
                if (regex_start.test(search_str) && search_str.length > self.options.min_length) {
                    search_str = search_str.replace(pattern, '');
                    return search_str.indexOf(' ') < 0 && !/[\r\n]/.test(search_str) ? search_str.replace(delimiter, '') : false;
                }
                return false;
            }

            this.active_listener = undefined;
            for (var i = 0; i < this.listeners.length; i++) {
                var listener = this.listeners[i];
                this.mention_word = validate_keyword(listener.delimiter);

                if (this.mention_word !== false) {
                    this.active_listener = listener;
                    break;
                }
            }

            // start a timeout to fetch data with the current 'mention word'. The timer avoid to start
            // an RPC for each pushed key when the user is still typing.
            // The 'typing_speed' option should approach the time for a human to type a letter.
            clearTimeout(this.mention_fetch_timer);
            this.mention_fetch_timer = setTimeout(function() {
                if (self.active_listener) {
                    $.when(listener.fetch_callback(self.mention_word)).then(function(suggestions) {
                        self.set('mention_suggestions', suggestions);
                    });
                } else {
                    self.set('mention_suggestions', []); // close the dropdown
                }
            }, this.options.typing_speed);
        },

        /**
         * Checks if a listener's selection should be updated after DELETE or BACKSPACE keypress
         */
        check_remove: function() {
            var self = this;
            var to_remove = [];
            var selection = this._get_selection_positions();
            var deleted_binf = selection.start;
            var deleted_bsup = selection.end;

            _.each(this.listeners, function(listener) {
                var mention_selection = listener.selection;
                var matches = self._get_match(self.composer.$txt.val(), listener);
                for (var i = 0; i < matches.length; i++) {
                    var m = matches[i];
                    var m1 = m.index;
                    var m2 = m.index + m[0].length;
                    if (deleted_binf <= m2 && m1 < deleted_bsup) {
                        to_remove.push(mention_selection[i]);
                    }
                }
                if (to_remove.length) {
                    listener.selection = _.difference(mention_selection, to_remove);
                }
            });
        },

        /**
         * Replaces mentions appearing in the string 's' by html links with proper redirection
         */
        generate_links: function(s) {

            var self = this;
            var base_href = session.url("/web");
            var mention_link = "[%s](%s){class=%s data-oe-id=%s data-oe-model=%s target=blank}";
            _.each(this.listeners, function(listener) {
                var selection = listener.selection;
                if (selection.length) {
                    var matches = self._get_match(s, listener);
                    var substrings = [];
                    var start_index = 0;
                    for (var i = 0; i < matches.length; i++) {
                        var match = matches[i];
                        var end_index = match.index + match[0].length;
                        var match_name = match[0].substring(1);
                        var href = base_href + _.str.sprintf("#model=%s&id=%s", listener.model, selection[i].id);
                        var processed_text = _.str.sprintf(mention_link, match_name, href, listener.redirect_classname, selection[i].id, listener.model);
                        var subtext = s.substring(start_index, end_index).replace(match[0], processed_text);
                        substrings.push(subtext);
                        start_index = end_index;
                    }
                    substrings.push(s.substring(start_index, s.length));
                    s = substrings.join('');
                }
            });
            return s;
        },

        reset_selections: function() {
            _.each(this.listeners, function(listener) {
                listener.selection = [];
            });
        },

        // Private functions
        /**
         * Returns the matches (as RexExp.exec does) for the mention in the input text
         * @param {String} input_text: the text to search matches
         * @param {Object} listener: the listener for which we want to find a match
         * @returns {Object[]} matches in the same format as RexExp.exec()
         */
        _get_match: function(input_text, listener) {
            // create the regex of all mention's names
            var names = _.pluck(listener.selection, 'name');
            var escaped_names = _.map(names, function(str) {
                return "(" + _.str.escapeRegExp(listener.delimiter + str) + ")";
            });
            var regex_str = escaped_names.join('|');
            // extract matches
            var result = [];
            if (regex_str.length) {
                var myRegexp = new RegExp(regex_str, 'g');
                var match = myRegexp.exec(input_text);
                while (match !== null) {
                    result.push(match);
                    match = myRegexp.exec(input_text);
                }
            }
            return result;
        },
        _render_suggestions: function() {
            if (_.flatten(this.get('mention_suggestions')).length) {
                this.$el.html(QWeb.render('mail.ChatComposer.MentionSuggestions', {
                    suggestions: this.get('mention_suggestions'),
                }));
                this.$el
                    .addClass('open')
                    .find('.o_mention_proposition').first().addClass('active');
                this.open = true;
            } else {
                this.$el.removeClass('open');
                this.$el.empty();
                this.open = false;
            }
        },

        // Cursor position and selection utils
        _get_selection_positions: function() {
            var el = this.composer.$txt.get(0);
            return el ? {
                start: el.selectionStart,
                end: el.selectionEnd
            } : {
                start: 0,
                end: 0
            };
        },
        _set_cursor_position: function(pos) {
            this.composer.$txt.each(function(index, elem) {
                if (elem.setSelectionRange) {
                    elem.setSelectionRange(pos, pos);
                } else if (elem.createTextRange) {
                    elem.createTextRange().collapse(true).moveEnd('character', pos).moveStart('character', pos).select();
                }
            });
        },

    });


    var FieldTextMarkDown = common.AbstractField.extend(
        common.ReinitializeFieldMixin, {

            template: 'FieldMarkDown',
            display_name: _lt('MarkDown'),
            widget_class: 'oe_form_field_bootstrap_markdown',
            events: {
                'change textarea': 'store_dom_value',
                'keydown .md-input': 'on_keydown',
                'keyup .md-input': 'on_keyup',
            },

            init: function(field_manager, node) {

                this._super(field_manager, node);
                ace_call.load()
                this.$txt = false;
                this.options = _.defaults(node || {}, {
                    context: {},
                    input_baseline: 18,
                    input_max_height: 150,
                    input_min_height: 28,
                    mention_fetch_limit: 8,
                });
                this.context = this.options.context;

                this.ace_mode = node.attrs['data-editor-mode'] !== undefined ? node.attrs['data-editor-mode'] : "xml";
                this.ace_theme = node.attrs['data-editor-theme'] !== undefined ? node.attrs['data-editor-theme'] : "chrome";

                this.md = markdownit({
                    html: true,
                    linkify: true,
                    typographer: true,
                    highlight: function(str, lang) {
                        if (lang && hljs.getLanguage(lang)) {
                            try {
                                return hljs.highlight(lang, str).value;
                            } catch (__) {}
                        }

                        try {
                            return hljs.highlightAuto(str).value;
                        } catch (__) {}

                        return ''; // use external default escaping
                    }
                });

                this.md.use(markdownItAttrs);
                this.old_value = null;

                // Mention
                this.mention_manager = new MentionManager(this);
                this.mention_manager.register({
                    delimiter: '@',
                    fetch_callback: this.mention_fetch_partners.bind(this),
                    model: 'res.partner',
                    redirect_classname: 'o_mail_redirect',
                });
                this.mention_manager.register({
                    delimiter: '#@',
                    fetch_callback: this.mention_fetch_channels.bind(this),
                    model: 'mail.channel',
                    redirect_classname: 'o_channel_redirect',
                });

                this.PartnerModel = new Model('res.partner');
                this.ChannelModel = new Model('mail.channel');
            },

            on_keydown: function(event) {
                switch (event.which) {
                    // UP, DOWN: prevent moving cursor if navigation in mention propositions
                    case $.ui.keyCode.UP:
                    case $.ui.keyCode.DOWN:
                        if (this.mention_manager.is_open()) {
                            event.preventDefault();
                        }
                        break;
                        // BACKSPACE, DELETE: check if need to remove a mention
                    case $.ui.keyCode.BACKSPACE:
                    case $.ui.keyCode.DELETE:
                        this.mention_manager.check_remove();
                        break;
                        // ENTER: submit the message only if the dropdown mention proposition is not displayed
                    case $.ui.keyCode.ENTER:
                        if (this.mention_manager.is_open()) {
                            event.preventDefault();
                        } else {
                            // this.resize_input(true);
                        }
                        break;
                }
            },

            on_keyup: function(event) {
                switch (event.which) {
                    // ESCAPED KEYS: do nothing
                    case $.ui.keyCode.END:
                    case $.ui.keyCode.PAGE_UP:
                    case $.ui.keyCode.PAGE_DOWN:
                        break;
                        // ESCAPE: close mention propositions
                    case $.ui.keyCode.ESCAPE:
                        this.set('mention_partners', []);
                        break;
                        // ENTER, UP, DOWN: check if navigation in mention propositions
                    case $.ui.keyCode.ENTER:
                    case $.ui.keyCode.UP:
                    case $.ui.keyCode.DOWN:
                        this.mention_manager.proposition_navigation(event.which);
                        break;
                        // Otherwise, check if a mention is typed
                    default:
                        this.mention_manager.detect_delimiter();
                        //this.resize_input();
                }
            },

            parse_value: function(val, def) {
                return formats.parse_value(val, this, def);
            },

            initialize_content: function() {
                // Gets called at each redraw of widget
                //  - switching between read-only mode and edit mode
                //  - BUT NOT when switching to next object.
                this.$txt = this.$el.find('textarea[name="' + this.name + '"]');
                if (!this.get('effective_readonly')) {
                    this.$txt.markdown({
                        autofocus: false,
                        savable: false
                    });
                }
                this.mention_manager.appendTo(this.$('.md-editor'));
                this.old_value = null; // will trigger a redraw
            },


            store_dom_value: function() {
                if (!this.get('effective_readonly') &&
                    this._get_raw_value() !== '' &&
                    this.is_syntax_valid()) {
                    // We use internal_set_value because we were called by
                    // ``.commit_value()`` which is called by a ``.set_value()``
                    // itself called because of a ``onchange`` event
                    this.internal_set_value(
                        this.parse_value(
                            this.mention_manager.generate_links(this._get_raw_value())
                        ));
                }
            },

            commit_value: function() {
                this.store_dom_value();
                return this._super();
            },

            _get_raw_value: function() {
                if (this.$txt === false)
                    return '';
                return this.$txt.val();
            },

            // Mention
            mention_fetch_channels: function(search) {
                var kwargs = {
                    limit: this.options.mention_fetch_limit,
                    search: search,
                };
                return this.ChannelModel
                    .call('get_mention_suggestions', kwargs)
                    .then(function(suggestions) {
                        return _.partition(suggestions, function(suggestion) {
                            return _.contains(['public', 'groups'], suggestion.public);
                        });
                    });
            },

            mention_fetch_partners: function(search) {
                var self = this;
                return $.when(this.mention_prefetched_partners).then(function(prefetched_partners) {
                    // filter prefetched partners with the given search string
                    var suggestions = [];
                    var limit = self.options.mention_fetch_limit;
                    var search_regexp = new RegExp(self.unaccent(search), 'i');
                    _.each(prefetched_partners, function(partners) {
                        if (limit > 0) {
                            var filtered_partners = _.filter(partners, function(partner) {
                                return partner.email && partner.email.search(search_regexp) !== -1 ||
                                    partner.name && self.unaccent(partner.name).search(search_regexp) !== -1;
                            });
                            if (filtered_partners.length) {
                                suggestions.push(filtered_partners.slice(0, limit));
                                limit -= filtered_partners.length;
                            }
                        }
                    });
                    if (!suggestions.length) {
                        // no result found among prefetched partners, fetch other suggestions
                        var kwargs = {
                            limit: limit,
                            search: search,
                        };
                        suggestions = self.PartnerModel.call('get_mention_suggestions', kwargs);
                    }
                    return suggestions;
                });
            },
            mention_set_prefetched_partners: function(prefetched_partners) {
                this.mention_prefetched_partners = prefetched_partners;
            },

            unaccent: function(str) {
                _.each(accented_letters_mapping, function(value, key) {
                    str = str.replace(new RegExp(value, 'g'), key);
                });
                return str;
            },

            render_value: function() {
                // Gets called at each redraw/save of widget
                //  - switching between read-only mode and edit mode
                //  - when switching to next object.

                var show_value = this.format_value(this.get('value'), '');
                if (!this.get("effective_readonly")) {
                    this.$txt.val(show_value);
                    this.$el.trigger('resize');
                    this.$txt.asAceEditor();

                } else {
                    var content = this.md.render(show_value)
                    this.$el.find('span[class="oe_form_text_content"]').html(content);
                }
            },

            format_value: function(val, def) {
                return formats.format_value(val, this, def);
            }
        }
    );

    core.form_widget_registry.add('bootstrap_markdown', FieldTextMarkDown);
});
