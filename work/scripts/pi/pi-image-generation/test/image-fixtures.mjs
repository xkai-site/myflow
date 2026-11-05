// Real 2x2 images encoded offline with Pillow 11.2.1, not relabelled PNG bytes.
// RGBA samples have alpha=0 at (0,0), alpha=255 elsewhere. JPEG/RGB samples are opaque.
// Pillow is only a fixture-authoring tool, not a test/runtime dependency.
export const imageFixtures = {
 png: { mimeType: 'image/png', extension: 'png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGPkqXjGwMDA8J8JRIBYACTtA2yriWpAAAAAAElFTkSuQmCC' },
 jpeg: { mimeType: 'image/jpeg', extension: 'jpg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDDooor9BPhz//Z' },
 webp: { mimeType: 'image/webp', extension: 'webp', data: 'UklGRiQAAABXRUJQVlA4TBgAAAAvAUAAEA8weMMw5vMf8FAIIAAKmoj+RwM=' },
};
export const opaquePng = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGPkqXjGwMDAxAAGABBIAW7W0/YgAAAAAElFTkSuQmCC' };
export const opaqueWebp = { mimeType: 'image/webp', data: 'UklGRjwAAABXRUJQVlA4IDAAAAAQAgCdASoCAAIAAUAmJaACdLoB+AH4AAPIAP7uCmf+2hnVCX/BN/9eiDxBv1NAAAA=' };
export const extendedWebp = { mimeType: 'image/webp', data: 'UklGRlwAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAAP///wBWUDggMAAAABACAJ0BKgIAAgABQCYloAJ0ugH4AfgAA8gA/u4KZ/7aGdUJf7cf/16IPEG/U0AAAA==' };
