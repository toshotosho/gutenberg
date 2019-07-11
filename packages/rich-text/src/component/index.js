/**
 * External dependencies
 */
import classnames from 'classnames';
import {
	find,
	isNil,
	pickBy,
} from 'lodash';

/**
 * WordPress dependencies
 */
import { Component } from '@wordpress/element';
import { BACKSPACE, DELETE, ENTER, LEFT, RIGHT, SPACE } from '@wordpress/keycodes';
import { withSelect } from '@wordpress/data';
import { withSafeTimeout, compose } from '@wordpress/compose';
import isShallowEqual from '@wordpress/is-shallow-equal';

/**
 * Internal dependencies
 */
import FormatEdit from './format-edit';
import Editable from './editable';
import { pickAriaProps } from './aria';
import { isEmpty } from '../is-empty';
import { create } from '../create';
import { apply, toDom } from '../to-dom';
import { toHTMLString } from '../to-html-string';
import { remove } from '../remove';
import { removeFormat } from '../remove-format';
import { isCollapsed } from '../is-collapsed';
import { LINE_SEPARATOR } from '../special-characters';
import { indentListItems } from '../indent-list-items';
import { getActiveFormats } from '../get-active-formats';
import { updateFormats } from '../update-formats';
import { removeLineSeparator } from '../remove-line-separator';

/**
 * Browser dependencies
 */

const { getSelection, getComputedStyle } = window;

/**
 * All inserting input types that would insert HTML into the DOM.
 *
 * @see https://www.w3.org/TR/input-events-2/#interface-InputEvent-Attributes
 *
 * @type {Set}
 */
const INSERTION_INPUT_TYPES_TO_IGNORE = new Set( [
	'insertParagraph',
	'insertOrderedList',
	'insertUnorderedList',
	'insertHorizontalRule',
	'insertLink',
] );

/**
 * Global stylesheet.
 */
const globalStyle = document.createElement( 'style' );

document.head.appendChild( globalStyle );

function createPrepareEditableTree( props, prefix ) {
	const fns = Object.keys( props ).reduce( ( accumulator, key ) => {
		if ( key.startsWith( prefix ) ) {
			accumulator.push( props[ key ] );
		}

		return accumulator;
	}, [] );

	return ( value ) => fns.reduce( ( accumulator, fn ) => {
		return fn( accumulator, value.text );
	}, value.formats );
}

/**
 * See export statement below.
 */
class RichText extends Component {
	constructor( {
		value,
		selectionStart,
		selectionEnd,
	} ) {
		super( ...arguments );

		this.onFocus = this.onFocus.bind( this );
		this.onBlur = this.onBlur.bind( this );
		this.onChange = this.onChange.bind( this );
		this.handleDelete = this.handleDelete.bind( this );
		this.handleEnter = this.handleEnter.bind( this );
		this.handleSpace = this.handleSpace.bind( this );
		this.handleHorizontalNavigation = this.handleHorizontalNavigation.bind( this );
		this.onPaste = this.onPaste.bind( this );
		this.onCreateUndoLevel = this.onCreateUndoLevel.bind( this );
		this.onInput = this.onInput.bind( this );
		this.onCompositionEnd = this.onCompositionEnd.bind( this );
		this.onSelectionChange = this.onSelectionChange.bind( this );
		this.createRecord = this.createRecord.bind( this );
		this.applyRecord = this.applyRecord.bind( this );
		this.valueToFormat = this.valueToFormat.bind( this );
		this.setRef = this.setRef.bind( this );
		this.valueToEditableHTML = this.valueToEditableHTML.bind( this );
		this.onPointerDown = this.onPointerDown.bind( this );
		this.formatToValue = this.formatToValue.bind( this );

		this.onKeyDown = ( event ) => {
			this.handleDelete( event );
			this.handleEnter( event );
			this.handleSpace( event );
			this.handleHorizontalNavigation( event );
		};

		this.state = {};
		this.lastHistoryValue = value;

		// Internal values are updated synchronously, unlike props and state.
		this.value = value;
		this.record = this.formatToValue( value );
		this.record.start = selectionStart;
		this.record.end = selectionEnd;
	}

	componentWillUnmount() {
		document.removeEventListener( 'selectionchange', this.onSelectionChange );
	}

	setRef( node ) {
		if ( node ) {
			if ( process.env.NODE_ENV === 'development' ) {
				const computedStyle = getComputedStyle( node );

				if ( computedStyle.display === 'inline' ) {
					// eslint-disable-next-line no-console
					console.warn( 'RichText cannot be used with an inline container. Please use a different tagName.' );
				}
			}

			this.editableRef = node;
		} else {
			delete this.editableRef;
		}
	}

	createRecord() {
		const { __unstableMultilineTag: multilineTag } = this.props;
		const selection = getSelection();
		const range = selection.rangeCount > 0 ? selection.getRangeAt( 0 ) : null;

		return create( {
			element: this.editableRef,
			range,
			multilineTag,
			multilineWrapperTags: multilineTag === 'li' ? [ 'ul', 'ol' ] : undefined,
			__unstableIsEditableTree: true,
		} );
	}

	applyRecord( record, { domOnly } = {} ) {
		const { __unstableMultilineTag: multilineTag } = this.props;

		apply( {
			value: record,
			current: this.editableRef,
			multilineTag,
			multilineWrapperTags: multilineTag === 'li' ? [ 'ul', 'ol' ] : undefined,
			prepareEditableTree: createPrepareEditableTree( this.props, 'format_prepare_functions' ),
			__unstableDomOnly: domOnly,
		} );
	}

	/**
	 * Handles a paste event.
	 *
	 * Saves the pasted data as plain text in `pastedPlainText`.
	 *
	 * @param {PasteEvent} event The paste event.
	 */
	onPaste( event ) {
		const { formatTypes, onPaste } = this.props;
		const clipboardData = event.clipboardData;
		let { items, files } = clipboardData;

		// In Edge these properties can be null instead of undefined, so a more
		// rigorous test is required over using default values.
		items = isNil( items ) ? [] : items;
		files = isNil( files ) ? [] : files;

		let plainText = '';
		let html = '';

		// IE11 only supports `Text` as an argument for `getData` and will
		// otherwise throw an invalid argument error, so we try the standard
		// arguments first, then fallback to `Text` if they fail.
		try {
			plainText = clipboardData.getData( 'text/plain' );
			html = clipboardData.getData( 'text/html' );
		} catch ( error1 ) {
			try {
				html = clipboardData.getData( 'Text' );
			} catch ( error2 ) {
				// Some browsers like UC Browser paste plain text by default and
				// don't support clipboardData at all, so allow default
				// behaviour.
				return;
			}
		}

		event.preventDefault();

		// Allows us to ask for this information when we get a report.
		window.console.log( 'Received HTML:\n\n', html );
		window.console.log( 'Received plain text:\n\n', plainText );

		const record = this.record;
		const transformed = formatTypes.reduce( ( accumlator, { __unstablePasteRule } ) => {
			// Only allow one transform.
			if ( __unstablePasteRule && accumlator === record ) {
				accumlator = __unstablePasteRule( record, { html, plainText } );
			}

			return accumlator;
		}, record );

		if ( transformed !== record ) {
			this.onChange( transformed );
			return;
		}

		if ( onPaste ) {
			// Only process file if no HTML is present.
			// Note: a pasted file may have the URL as plain text.
			const image = find( [ ...items, ...files ], ( { type } ) =>
				/^image\/(?:jpe?g|png|gif)$/.test( type )
			);

			onPaste( {
				value: this.removeEditorOnlyFormats( record ),
				onChange: this.onChange,
				html,
				plainText,
				image,
			} );
		}
	}

	/**
	 * Handles a focus event on the contenteditable field, calling the
	 * `unstableOnFocus` prop callback if one is defined. The callback does not
	 * receive any arguments.
	 *
	 * This is marked as a private API and the `unstableOnFocus` prop is not
	 * documented, as the current requirements where it is used are subject to
	 * future refactoring following `isSelected` handling.
	 *
	 * In contrast with `setFocusedElement`, this is only triggered in response
	 * to focus within the contenteditable field, whereas `setFocusedElement`
	 * is triggered on focus within any `RichText` descendent element.
	 *
	 * @see setFocusedElement
	 *
	 * @private
	 */
	onFocus() {
		const { unstableOnFocus } = this.props;

		if ( unstableOnFocus ) {
			unstableOnFocus();
		}

		this.recalculateBoundaryStyle();

		// We know for certain that on focus, the old selection is invalid. It
		// will be recalculated on `selectionchange`.
		const index = undefined;
		const activeFormats = undefined;

		this.record = {
			...this.record,
			start: index,
			end: index,
			activeFormats,
		};
		this.props.onSelectionChange( index, index );
		this.setState( { activeFormats } );

		document.addEventListener( 'selectionchange', this.onSelectionChange );
	}

	onBlur() {
		document.removeEventListener( 'selectionchange', this.onSelectionChange );
	}

	/**
	 * Handle input on the next selection change event.
	 *
	 * @param {SyntheticEvent} event Synthetic input event.
	 */
	onInput( event ) {
		// For Input Method Editor (IME), used in Chinese, Japanese, and Korean
		// (CJK), do not trigger a change if characters are being composed.
		// Browsers setting `isComposing` to `true` will usually emit a final
		// `input` event when the characters are composed.
		if ( event && event.nativeEvent.isComposing ) {
			// Also don't update any selection.
			document.removeEventListener( 'selectionchange', this.onSelectionChange );
			return;
		}

		if ( event && event.nativeEvent.inputType ) {
			const { inputType } = event.nativeEvent;

			// The browser formatted something or tried to insert HTML.
			// Overwrite it. It will be handled later by the format library if
			// needed.
			if (
				inputType.indexOf( 'format' ) === 0 ||
				INSERTION_INPUT_TYPES_TO_IGNORE.has( inputType )
			) {
				this.applyRecord( this.record );
				return;
			}
		}

		const value = this.createRecord();
		const { start, activeFormats = [] } = this.record;

		// Update the formats between the last and new caret position.
		const change = updateFormats( {
			value,
			start,
			end: value.start,
			formats: activeFormats,
		} );

		this.onChange( change, { withoutHistory: true } );

		const { __unstableInputRule: inputRule, formatTypes } = this.props;

		if ( inputRule ) {
			inputRule( change, this.valueToFormat );
		}

		const transformed = formatTypes.reduce( ( accumlator, { __unstableInputRule } ) => {
			if ( __unstableInputRule ) {
				accumlator = __unstableInputRule( accumlator );
			}

			return accumlator;
		}, change );

		if ( transformed !== change ) {
			this.onCreateUndoLevel();
			this.onChange( { ...transformed, activeFormats } );
		}

		// Create an undo level when input stops for over a second.
		this.props.clearTimeout( this.onInput.timeout );
		this.onInput.timeout = this.props.setTimeout( this.onCreateUndoLevel, 1000 );
	}

	onCompositionEnd() {
		// Ensure the value is up-to-date for browsers that don't emit a final
		// input event after composition.
		this.onInput();
		// Tracking selection changes can be resumed.
		document.addEventListener( 'selectionchange', this.onSelectionChange );
	}

	/**
	 * Handles the `selectionchange` event: sync the selection to local state.
	 */
	onSelectionChange() {
		const { start, end } = this.createRecord();
		const value = this.record;

		if ( start === value.start && end === value.end ) {
			return;
		}

		const {
			__unstableIsCaretWithinFormattedText: isCaretWithinFormattedText,
			__unstableOnEnterFormattedText: onEnterFormattedText,
			__unstableOnExitFormattedText: onExitFormattedText,
		} = this.props;
		const newValue = {
			...value,
			start,
			end,
			// Allow `getActiveFormats` to get new `activeFormats`.
			activeFormats: undefined,
		};

		const activeFormats = getActiveFormats( newValue );

		// Update the value with the new active formats.
		newValue.activeFormats = activeFormats;

		if ( ! isCaretWithinFormattedText && activeFormats.length ) {
			onEnterFormattedText();
		} else if ( isCaretWithinFormattedText && ! activeFormats.length ) {
			onExitFormattedText();
		}

		// It is important that the internal value is updated first,
		// otherwise the value will be wrong on render!
		this.record = newValue;
		this.applyRecord( newValue, { domOnly: true } );
		this.props.onSelectionChange( start, end );
		this.setState( { activeFormats } );

		if ( activeFormats.length > 0 ) {
			this.recalculateBoundaryStyle();
		}
	}

	recalculateBoundaryStyle() {
		const boundarySelector = '*[data-rich-text-format-boundary]';
		const element = this.editableRef.querySelector( boundarySelector );

		if ( ! element ) {
			return;
		}

		const computedStyle = getComputedStyle( element );
		const newColor = computedStyle.color
			.replace( ')', ', 0.2)' )
			.replace( 'rgb', 'rgba' );
		const selector = `.rich-text:focus ${ boundarySelector }`;
		const rule = `background-color: ${ newColor }`;

		globalStyle.innerHTML = `${ selector } {${ rule }}`;
	}

	/**
	 * Sync the value to global state. The node tree and selection will also be
	 * updated if differences are found.
	 *
	 * @param {Object}  record            The record to sync and apply.
	 * @param {Object}  $2                Named options.
	 * @param {boolean} $2.withoutHistory If true, no undo level will be
	 *                                    created.
	 */
	onChange( record, { withoutHistory } = {} ) {
		this.applyRecord( record );

		const { start, end, activeFormats = [] } = record;
		const changeHandlers = pickBy( this.props, ( v, key ) =>
			key.startsWith( 'format_on_change_functions_' )
		);

		Object.values( changeHandlers ).forEach( ( changeHandler ) => {
			changeHandler( record.formats, record.text );
		} );

		this.value = this.valueToFormat( record );
		this.record = record;
		this.props.onChange( this.value );
		this.props.onSelectionChange( start, end );
		this.setState( { activeFormats } );

		if ( ! withoutHistory ) {
			this.onCreateUndoLevel();
		}
	}

	onCreateUndoLevel() {
		// If the content is the same, no level needs to be created.
		if ( this.lastHistoryValue === this.value ) {
			return;
		}

		this.props.__unstableOnCreateUndoLevel();
		this.lastHistoryValue = this.value;
	}

	/**
	 * Handles delete on keydown:
	 * - outdent list items,
	 * - delete content if everything is selected,
	 * - trigger the onDelete prop when selection is uncollapsed and at an edge.
	 *
	 * @param {SyntheticEvent} event A synthetic keyboard event.
	 */
	handleDelete( event ) {
		const { keyCode } = event;

		if ( keyCode !== DELETE && keyCode !== BACKSPACE ) {
			return;
		}

		const { onDelete, __unstableMultilineTag: multilineTag } = this.props;
		const { start, end, text, activeFormats } = this.record;
		const isReverse = keyCode === BACKSPACE;

		if ( multilineTag ) {
			const newValue = removeLineSeparator( this.record, isReverse );
			if ( newValue ) {
				this.onChange( newValue );
				event.preventDefault();
			}
		}

		// Always handle full content deletion ourselves.
		if ( start === 0 && end !== 0 && end === text.length ) {
			this.onChange( remove( this.record ) );
			event.preventDefault();
			return;
		}

		// Only process delete if the key press occurs at an uncollapsed edge.
		if (
			! onDelete ||
			! isCollapsed( this.record ) ||
			activeFormats.length ||
			( isReverse && start !== 0 ) ||
			( ! isReverse && end !== text.length )
		) {
			return;
		}

		onDelete( { isReverse, isEmpty: isEmpty( this.record ) } );
		event.preventDefault();
	}

	/**
	 * Triggers the `onEnter` prop on keydown.
	 *
	 * @param {SyntheticEvent} event A synthetic keyboard event.
	 */
	handleEnter( event ) {
		if ( event.keyCode !== ENTER ) {
			return;
		}

		event.preventDefault();

		const { onEnter } = this.props;

		if ( ! onEnter ) {
			return;
		}

		onEnter( {
			value: this.removeEditorOnlyFormats( this.createRecord() ),
			onChange: this.onChange,
			shiftKey: event.shiftKey,
		} );
	}

	/**
	 * Indents list items on space keydown.
	 *
	 * @param {SyntheticEvent} event A synthetic keyboard event.
	 */
	handleSpace( event ) {
		const { tagName, __unstableMultilineTag: multilineTag } = this.props;

		if (
			event.keyCode !== SPACE ||
			multilineTag !== 'li' ||
			! isCollapsed( this.record )
		) {
			return;
		}

		const { text, start } = this.record;
		const characterBefore = text[ start - 1 ];

		// The caret must be at the start of a line.
		if ( characterBefore && characterBefore !== LINE_SEPARATOR ) {
			return;
		}

		this.onChange( indentListItems( this.record, { type: tagName } ) );
		event.preventDefault();
	}

	/**
	 * Handles horizontal keyboard navigation when no modifiers are pressed. The
	 * navigation is handled separately to move correctly around format
	 * boundaries.
	 *
	 * @param  {SyntheticEvent} event A synthetic keyboard event.
	 */
	handleHorizontalNavigation( event ) {
		const { keyCode, shiftKey, altKey, metaKey, ctrlKey } = event;

		if (
			// Only override left and right keys without modifiers pressed.
			shiftKey || altKey || metaKey || ctrlKey ||
			( keyCode !== LEFT && keyCode !== RIGHT )
		) {
			return;
		}

		const { text, formats, start, end, activeFormats = [] } = this.record;
		const collapsed = isCollapsed( this.record );
		// To do: ideally, we should look at visual position instead.
		const { direction } = getComputedStyle( this.editableRef );
		const reverseKey = direction === 'rtl' ? RIGHT : LEFT;
		const isReverse = event.keyCode === reverseKey;

		// If the selection is collapsed and at the very start, do nothing if
		// navigating backward.
		// If the selection is collapsed and at the very end, do nothing if
		// navigating forward.
		if ( collapsed && activeFormats.length === 0 ) {
			if ( start === 0 && isReverse ) {
				return;
			}

			if ( end === text.length && ! isReverse ) {
				return;
			}
		}

		// If the selection is not collapsed, let the browser handle collapsing
		// the selection for now. Later we could expand this logic to set
		// boundary positions if needed.
		if ( ! collapsed ) {
			return;
		}

		// In all other cases, prevent default behaviour.
		event.preventDefault();

		const formatsBefore = formats[ start - 1 ] || [];
		const formatsAfter = formats[ start ] || [];

		let newActiveFormatsLength = activeFormats.length;
		let source = formatsAfter;

		if ( formatsBefore.length > formatsAfter.length ) {
			source = formatsBefore;
		}

		// If the amount of formats before the caret and after the caret is
		// different, the caret is at a format boundary.
		if ( formatsBefore.length < formatsAfter.length ) {
			if ( ! isReverse && activeFormats.length < formatsAfter.length ) {
				newActiveFormatsLength++;
			}

			if ( isReverse && activeFormats.length > formatsBefore.length ) {
				newActiveFormatsLength--;
			}
		} else if ( formatsBefore.length > formatsAfter.length ) {
			if ( ! isReverse && activeFormats.length > formatsAfter.length ) {
				newActiveFormatsLength--;
			}

			if ( isReverse && activeFormats.length < formatsBefore.length ) {
				newActiveFormatsLength++;
			}
		}

		// Wait for boundary class to be added.
		this.props.setTimeout( () => this.recalculateBoundaryStyle() );

		if ( newActiveFormatsLength !== activeFormats.length ) {
			const newActiveFormats = source.slice( 0, newActiveFormatsLength );
			const newValue = { ...this.record, activeFormats: newActiveFormats };
			this.record = newValue;
			this.applyRecord( newValue );
			this.setState( { activeFormats: newActiveFormats } );
			return;
		}

		const newPos = start + ( isReverse ? -1 : 1 );
		const newActiveFormats = isReverse ? formatsBefore : formatsAfter;
		const newValue = {
			...this.record,
			start: newPos,
			end: newPos,
			activeFormats: newActiveFormats,
		};

		this.record = newValue;
		this.applyRecord( newValue );
		this.props.onSelectionChange( newPos, newPos );
		this.setState( { activeFormats: newActiveFormats } );
	}

	/**
	 * Select object when they are clicked. The browser will not set any
	 * selection when clicking e.g. an image.
	 *
	 * @param  {SyntheticEvent} event Synthetic mousedown or touchstart event.
	 */
	onPointerDown( event ) {
		const { target } = event;

		// If the child element has no text content, it must be an object.
		if ( target === this.editableRef || target.textContent ) {
			return;
		}

		const { parentNode } = target;
		const index = Array.from( parentNode.childNodes ).indexOf( target );
		const range = target.ownerDocument.createRange();
		const selection = getSelection();

		range.setStart( target.parentNode, index );
		range.setEnd( target.parentNode, index + 1 );

		selection.removeAllRanges();
		selection.addRange( range );
	}

	componentDidUpdate( prevProps ) {
		const {
			tagName,
			value,
			selectionStart,
			selectionEnd,
			__unstableIsSelected: isSelected,
		} = this.props;

		// Check if the content changed.
		let shouldReapply = (
			tagName === prevProps.tagName &&
			value !== prevProps.value &&
			value !== this.value
		);

		// Check if the selection changed.
		shouldReapply = shouldReapply || (
			isSelected && ! prevProps.isSelected && (
				this.record.start !== selectionStart ||
				this.record.end !== selectionEnd
			)
		);

		const prefix = 'format_prepare_props_';
		const predicate = ( v, key ) => key.startsWith( prefix );
		const prepareProps = pickBy( this.props, predicate );
		const prevPrepareProps = pickBy( prevProps, predicate );

		// Check if any format props changed.
		shouldReapply = shouldReapply ||
			! isShallowEqual( prepareProps, prevPrepareProps );

		const { activeFormats = [] } = this.record;

		if ( shouldReapply ) {
			this.value = value;
			this.record = this.formatToValue( value );
			this.record.start = selectionStart;
			this.record.end = selectionEnd;

			updateFormats( {
				value: this.record,
				start: this.record.start,
				end: this.record.end,
				formats: activeFormats,
			} );

			this.applyRecord( this.record );
		} else if (
			this.record.start !== selectionStart ||
			this.record.end !== selectionEnd
		) {
			this.record = {
				...this.record,
				start: selectionStart,
				end: selectionEnd,
			};
		}
	}

	/**
	 * Converts the outside data structure to our internal representation.
	 *
	 * @param {*} value The outside value, data type depends on props.
	 * @return {Object} An internal rich-text value.
	 */
	formatToValue( value ) {
		const { format, __unstableMultilineTag: multilineTag } = this.props;

		if ( format !== 'string' ) {
			return value;
		}

		const prepare = createPrepareEditableTree( this.props, 'format_value_functions' );

		value = create( {
			html: value,
			multilineTag,
			multilineWrapperTags: multilineTag === 'li' ? [ 'ul', 'ol' ] : undefined,
		} );
		value.formats = prepare( value );

		return value;
	}

	valueToEditableHTML( value ) {
		const { __unstableMultilineTag: multilineTag } = this.props;

		return toDom( {
			value,
			multilineTag,
			prepareEditableTree: createPrepareEditableTree( this.props, 'format_prepare_functions' ),
		} ).body.innerHTML;
	}

	/**
	 * Removes editor only formats from the value.
	 *
	 * Editor only formats are applied using `prepareEditableTree`, so we need to
	 * remove them before converting the internal state
	 *
	 * @param {Object} value The internal rich-text value.
	 * @return {Object} A new rich-text value.
	 */
	removeEditorOnlyFormats( value ) {
		this.props.formatTypes.forEach( ( formatType ) => {
			// Remove formats created by prepareEditableTree, because they are editor only.
			if ( formatType.__experimentalCreatePrepareEditableTree ) {
				value = removeFormat( value, formatType.name, 0, value.text.length );
			}
		} );

		return value;
	}

	/**
     * Converts the internal value to the external data format.
     *
     * @param {Object} value The internal rich-text value.
     * @return {*} The external data format, data type depends on props.
     */
	valueToFormat( value ) {
		const { format, __unstableMultilineTag: multilineTag } = this.props;

		value = this.removeEditorOnlyFormats( value );

		if ( format !== 'string' ) {
			return;
		}

		return toHTMLString( { value, multilineTag } );
	}

	render() {
		const {
			tagName: Tagname = 'div',
			style,
			wrapperClassName,
			className,
			placeholder,
			keepPlaceholderOnFocus = false,
			__unstableIsSelected: isSelected,
			children,
			__unstableMultilineTag: multilineTag,
			// To do: move autocompletion logic to rich-text.
			__unstableAutocompleters: autocompleters,
			__unstableAutocomplete: Autocomplete = ( { children: ch } ) => ch( {} ),
			__unstableOnReplace: onReplace,
		} = this.props;

		// Generating a key that includes `tagName` ensures that if the tag
		// changes, we replace the relevant element. This is needed because we
		// prevent Editable component updates.
		const key = Tagname;
		const MultilineTag = multilineTag;
		const ariaProps = pickAriaProps( this.props );
		const record = this.record;
		const isPlaceholderVisible = placeholder && ( ! isSelected || keepPlaceholderOnFocus ) && isEmpty( record );

		const autoCompleteContent = ( { listBoxId, activeId } ) => (
			<>
				<Editable
					tagName={ Tagname }
					style={ style }
					record={ record }
					valueToEditableHTML={ this.valueToEditableHTML }
					isPlaceholderVisible={ isPlaceholderVisible }
					aria-label={ placeholder }
					aria-autocomplete={ listBoxId ? 'list' : undefined }
					aria-owns={ listBoxId }
					aria-activedescendant={ activeId }
					{ ...ariaProps }
					className={ classnames( 'rich-text', className ) }
					key={ key }
					onPaste={ this.onPaste }
					onInput={ this.onInput }
					onCompositionEnd={ this.onCompositionEnd }
					onKeyDown={ this.onKeyDown }
					onFocus={ this.onFocus }
					onBlur={ this.onBlur }
					onMouseDown={ this.onPointerDown }
					onTouchStart={ this.onPointerDown }
					setRef={ this.setRef }
				/>
				{ isPlaceholderVisible &&
					<Tagname
						className={ classnames( 'rich-text', className ) }
						style={ style }
					>
						{ MultilineTag ? <MultilineTag>{ placeholder }</MultilineTag> : placeholder }
					</Tagname>
				}
				{ isSelected && <FormatEdit value={ record } onChange={ this.onChange } /> }
			</>
		);

		const content = (
			<Autocomplete
				onReplace={ onReplace }
				completers={ autocompleters }
				record={ record }
				onChange={ this.onChange }
			>
				{ autoCompleteContent }
			</Autocomplete>
		);

		if ( ! children ) {
			return content;
		}

		return (
			<div className={ wrapperClassName }>
				{ children( {
					isSelected,
					value: record,
					onChange: this.onChange,
				} ) }
				{ content }
			</div>
		);
	}
}

RichText.defaultProps = {
	format: 'string',
	value: '',
};

/**
 * Renders a rich content input, providing users with the option to format the
 * content.
 */
export default compose( [
	withSelect( ( select ) => ( {
		formatTypes: select( 'core/rich-text' ).getFormatTypes(),
	} ) ),
	withSafeTimeout,
] )( RichText );
