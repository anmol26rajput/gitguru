package utils

import "strings"

// Slugify turns a title into a URL-friendly slug.
func Slugify(title string) string {
	return strings.ReplaceAll(strings.ToLower(title), " ", "-")
}
