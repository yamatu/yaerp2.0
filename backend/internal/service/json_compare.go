package service

import (
	"bytes"
	"encoding/json"
)

// sameJSONText reports whether two JSON texts are identical apart from
// whitespace outside strings. Snapshots read back from a jsonb column come
// with spaces after ':' and ',' while clients send compact JSON, so a byte
// comparison never matches; this check needs no decoding. A false result does
// not mean the values differ (keys may be ordered differently): callers fall
// back to a semantic comparison then.
func sameJSONText(left, right []byte) bool {
	i, j := 0, 0
	inString := false
	for {
		if !inString {
			for i < len(left) && isJSONSpace(left[i]) {
				i++
			}
			for j < len(right) && isJSONSpace(right[j]) {
				j++
			}
		}
		if i == len(left) || j == len(right) {
			return i == len(left) && j == len(right)
		}
		if left[i] != right[j] {
			return false
		}
		switch {
		case inString && left[i] == '\\':
			// The escaped character is compared literally on the next pass.
			i++
			j++
			if i == len(left) || j == len(right) || left[i] != right[j] {
				return false
			}
		case left[i] == '"':
			inString = !inString
		}
		i++
		j++
	}
}

func isJSONSpace(value byte) bool {
	return value == ' ' || value == '\n' || value == '\r' || value == '\t'
}

// sameJSONValue reports whether two JSON texts hold the same value, using the
// cheap textual check first and decoding only when it is inconclusive.
func sameJSONValue(left, right []byte) bool {
	if bytes.Equal(left, right) || sameJSONText(left, right) {
		return true
	}
	var leftValue, rightValue any
	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
		return false
	}
	leftJSON, leftErr := json.Marshal(leftValue)
	rightJSON, rightErr := json.Marshal(rightValue)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}
